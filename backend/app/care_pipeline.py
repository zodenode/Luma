"""
End-to-end care flow after an inbound stimulus (chat line or raw event).

1. Create event
2. Update state
3. Run rules engine
4. Trigger actions
5. AI generates response using full context (chat path only)
"""

from typing import Any

from sqlalchemy.orm import Session

from app.ai_coaching.engine import build_coaching_context, generate_chat_reply
from core.actions.orchestrator import execute_actions
from core.events.schemas import CareEventCreate
from core.events.ingestion import persist_event
from core.rules.engine import RuleMatch, evaluate_rules_for_event
from core.state.engine import apply_event_to_state
from app.models import Event, User, UserState


def run_post_event_pipeline(
    db: Session,
    user: User,
    event: Event,
    *,
    action_context: dict[str, Any] | None = None,
) -> tuple[list[str], list[int], list[RuleMatch]]:
    """Steps 2–4. Returns (flattened action names, action_log ids, rule matches)."""
    apply_event_to_state(db, user, event)
    matches = evaluate_rules_for_event(db, user.id, event)
    ctx = action_context or {}
    ctx.setdefault("external_user_id", user.external_id)
    ctx.setdefault("reason", event.event_type)

    all_actions: list[str] = []
    log_ids: list[int] = []
    for m in matches:
        all_actions.extend(m.actions)
        logs = execute_actions(
            db, user.id, event.id, m.actions, {**ctx, "rule_name": m.rule_name}
        )
        log_ids.extend(l.id for l in logs)
    return all_actions, log_ids, matches


def process_chat_message(
    db: Session,
    external_user_id: str,
    message: str,
    history: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    body = CareEventCreate(
        event_type="chat_message",
        user_id=external_user_id,
        payload={"text": message, "topic": None},
    )
    event = persist_event(db, body)
    db.refresh(event)
    user = db.query(User).filter(User.id == event.user_id).one()

    actions, action_log_ids, matches = run_post_event_pipeline(
        db,
        user,
        event,
        action_context={"sms_body": f"Quick check-in: {message[:80]}"},
    )

    state = db.get(UserState, user.id)
    if state is None:
        raise RuntimeError("user_state missing after pipeline")
    coaching_ctx = build_coaching_context(db, user, state, matches)
    reply = generate_chat_reply(message, history, coaching_ctx)

    return {
        "reply": reply,
        "trace": {
            "event_id": event.id,
            "actions_triggered": actions,
            "action_log_ids": action_log_ids,
            "coaching_context": coaching_ctx,
        },
    }


def process_external_event(db: Session, body: CareEventCreate) -> dict[str, Any]:
    """Ingest-only path with full pipeline (no chat reply)."""
    event = persist_event(db, body)
    db.refresh(event)
    user = db.query(User).filter(User.id == event.user_id).one()
    actions, action_log_ids, _matches = run_post_event_pipeline(db, user, event)
    return {
        "event_id": event.id,
        "actions_triggered": actions,
        "action_log_ids": action_log_ids,
    }
