from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.ai_coaching.engine import build_coaching_context, generate_chat_reply
from app.care_pipeline import process_chat_message, process_external_event
from core.events.schemas import CareEventCreate, CareEventResponse
from app.database import get_db, init_db
from app.models import Event, Rule, User, UserState
from app.seed import seed_default_rules


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    db = next(get_db())
    try:
        seed_default_rules(db)
    finally:
        db.close()
    yield


app = FastAPI(title="Luma Care API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatMessage(BaseModel):
    user_id: str = Field(..., description="External user id (stable string)")
    message: str
    history: list[dict[str, str]] | None = None


class ChatResponse(BaseModel):
    reply: str
    trace: dict | None = Field(
        default=None,
        description="Event → rules → actions → coaching context; safe to ignore for legacy UIs",
    )


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/api/chat", response_model=ChatResponse)
@app.post("/chat", response_model=ChatResponse)
def chat(body: ChatMessage, db: Session = Depends(get_db)):
    """
    Backward-compatible chat: same request shape; response includes structured
    care pipeline trace without removing the `reply` field.
    """
    result = process_chat_message(db, body.user_id, body.message, body.history)
    db.commit()
    return ChatResponse(reply=result["reply"], trace=result["trace"])


@app.post("/api/events", response_model=dict)
def ingest_event(body: CareEventCreate, db: Session = Depends(get_db)):
    out = process_external_event(db, body)
    db.commit()
    return out


@app.get("/api/users/{external_id}/state")
def get_user_state(external_id: str, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.external_id == external_id).one_or_none()
    if not user:
        return {"external_id": external_id, "state": None}
    st = db.get(UserState, user.id)
    if not st:
        return {"external_id": external_id, "state": None}
    ctx = build_coaching_context(db, user, st, [])
    return {"external_id": external_id, "state": ctx["user_state"]}


@app.get("/api/rules")
def list_rules(db: Session = Depends(get_db)):
    rows = db.query(Rule).order_by(Rule.id).all()
    return [
        {"id": r.id, "name": r.name, "enabled": r.enabled, "rule_json": r.rule_json}
        for r in rows
    ]


@app.get("/api/users/{external_id}/events")
def list_events(external_id: str, limit: int = 50, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.external_id == external_id).one_or_none()
    if not user:
        return {"events": []}
    q = (
        db.query(Event)
        .filter(Event.user_id == user.id)
        .order_by(Event.timestamp.desc())
        .limit(limit)
    )
    events = []
    for e in q:
        events.append(
            CareEventResponse(
                id=e.id,
                event_type=e.event_type,
                user_id=user.external_id,
                timestamp=e.timestamp,
                payload=e.payload or {},
            )
        )
    return {"events": events}


@app.post("/api/dev/preview-reply")
def preview_reply(body: ChatMessage, db: Session = Depends(get_db)):
    """Build coaching context without persisting (optional helper)."""
    user = db.query(User).filter(User.external_id == body.user_id).one_or_none()
    if not user:
        return {"reply": generate_chat_reply(body.message, body.history, {}), "note": "no user row"}
    st = db.get(UserState, user.id)
    if not st:
        return {"reply": generate_chat_reply(body.message, body.history, {}), "note": "no state"}
    ctx = build_coaching_context(db, user, st, [])
    return {"reply": generate_chat_reply(body.message, body.history, ctx), "context": ctx}
