from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException
from sqlalchemy.orm import Session

from backend.ai.coaching import build_ai_context, generate_coaching_reply
from backend.config import settings
from backend.core.actions import run_actions
from backend.core.events import ingest_event
from backend.core.rules import evaluate_rules_for_event
from backend.core.schemas import (
    ActionLogOut,
    CareEventIn,
    CareEventOut,
    ChatMessageIn,
    ChatMessageOut,
    RuleIn,
    RuleOut,
    UserStateOut,
)
from backend.core.state import apply_event_to_state
from backend import database as db_module
from backend.database import Base, get_db
from backend.models import ActionLog, Rule, User, UserState


def seed_default_rules(db: Session) -> None:
    if db.query(Rule).count() > 0:
        return
    db.add_all(
        [
            Rule(
                name="Medication miss escalation",
                enabled=True,
                definition={
                    "event_type": "medication_missed",
                    "conditions": {"count_last_7_days": "> 2"},
                    "actions": ["send_ai_message", "schedule_checkin", "notify_clinician"],
                },
            ),
            Rule(
                name="Symptom → coaching touchpoint",
                enabled=True,
                definition={
                    "event_type": "symptom_reported",
                    "conditions": {},
                    "actions": ["send_ai_message"],
                },
            ),
            Rule(
                name="Consult complete → onboarding",
                enabled=True,
                definition={
                    "event_type": "consult_completed",
                    "conditions": {},
                    "actions": ["send_ai_message", "openloop_notify"],
                },
            ),
        ]
    )
    db.commit()


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=db_module.engine)
    with Session(db_module.engine) as db:
        seed_default_rules(db)
    yield


app = FastAPI(title=settings.app_name, lifespan=lifespan)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/v1/events", response_model=CareEventOut)
def post_event(body: CareEventIn, db: Session = Depends(get_db)):
    ev = ingest_event(db, body)
    apply_event_to_state(db, body.user_id, body.event_type, ev.timestamp)
    matched = evaluate_rules_for_event(db, body.user_id, body.event_type, ev.timestamp)
    action_ctx = {"event_type": body.event_type, "payload": body.payload}
    for rule, actions in matched:
        run_actions(db, user_id=body.user_id, event_id=ev.id, actions=actions, rule=rule, context=action_ctx)
    db.commit()
    db.refresh(ev)
    return ev


@app.get("/v1/users/{user_id}/state", response_model=UserStateOut)
def get_state(user_id: str, db: Session = Depends(get_db)):
    row = db.get(UserState, user_id)
    if not row:
        raise HTTPException(404, "No state for user; ingest an event or chat first")
    return row


@app.post("/v1/rules", response_model=RuleOut)
def create_rule(body: RuleIn, db: Session = Depends(get_db)):
    r = Rule(name=body.name, enabled=body.enabled, definition=body.definition)
    db.add(r)
    db.commit()
    db.refresh(r)
    return r


@app.get("/v1/rules", response_model=list[RuleOut])
def list_rules(db: Session = Depends(get_db)):
    return db.query(Rule).all()


@app.get("/v1/users/{user_id}/actions", response_model=list[ActionLogOut])
def list_user_actions(user_id: str, db: Session = Depends(get_db)):
    return (
        db.query(ActionLog)
        .filter(ActionLog.user_id == user_id)
        .order_by(ActionLog.created_at.desc())
        .limit(100)
        .all()
    )


@app.post("/v1/chat", response_model=ChatMessageOut)
def chat(body: ChatMessageIn, db: Session = Depends(get_db)):
    """
    Backward-compatible chat endpoint with care pipeline:
    message → event → state → rules → actions → AI (wrapped legacy).
    """
    user = db.query(User).filter(User.id == body.user_id).first()
    if not user:
        db.add(User(id=body.user_id))
        db.flush()

    ev = ingest_event(
        db,
        CareEventIn(
            event_type="chat_message",
            user_id=body.user_id,
            payload={"text": body.message},
        ),
    )
    state = apply_event_to_state(db, body.user_id, "chat_message", ev.timestamp)
    matched = evaluate_rules_for_event(db, body.user_id, "chat_message", ev.timestamp)
    action_ctx = {
        "event_type": "chat_message",
        "message": body.message,
        "treatment_context": body.treatment_context or {},
    }
    for rule, actions in matched:
        run_actions(db, user_id=body.user_id, event_id=ev.id, actions=actions, rule=rule, context=action_ctx)

    ai_context = build_ai_context(
        db,
        user_id=body.user_id,
        state=state,
        matched_rules=matched,
        treatment_context=body.treatment_context,
    )
    reply = generate_coaching_reply(body.message, context=ai_context)

    db.commit()
    trace = {
        "event_id": ev.id,
        "matched_rules": [{"rule_id": r.id, "actions": a} for r, a in matched],
        "ai_context_keys": list(ai_context.keys()),
    }
    return ChatMessageOut(reply=reply, event_id=ev.id, trace=trace)


@app.post("/v1/chat/legacy")
def chat_legacy(body: ChatMessageIn, db: Session = Depends(get_db)):
    """Explicit opt-in to pre-care-engine behaviour (no pipeline)."""
    from backend.ai.legacy_chat import legacy_reply_from_history

    return {"reply": legacy_reply_from_history(body.message)}
