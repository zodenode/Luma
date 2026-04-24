from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.ai.coaching import build_ai_context, generate_coaching_response
from backend.core.actions import run_actions
from backend.core.events import CareEvent, ingest_event
from backend.core.models import Event, User
from backend.core.rules import evaluate_rules_for_event
from backend.core.state import get_user_state_snapshot, refresh_user_state


def get_or_create_user(db: Session, external_user_id: str) -> User:
    row = db.scalar(select(User).where(User.external_id == external_user_id))
    if row:
        return row
    u = User(external_id=external_user_id)
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _recent_events(db: Session, user_id: str, limit: int = 20) -> list[dict[str, Any]]:
    rows = db.scalars(
        select(Event)
        .where(Event.user_id == user_id)
        .order_by(Event.timestamp.desc())
        .limit(limit)
    ).all()
    out: list[dict[str, Any]] = []
    for r in reversed(rows):
        ts = r.timestamp
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        out.append(
            {
                "id": r.id,
                "event_type": r.event_type,
                "timestamp": ts.isoformat(),
                "payload": r.payload,
            }
        )
    return out


def process_chat_turn(
    db: Session,
    user: User,
    message: str,
) -> dict[str, Any]:
    """
    Chat flow: event → state → rules → actions → AI (wrapped).
    """
    now = datetime.now(timezone.utc)

    chat_event = CareEvent(
        event_type="chat_message_received",
        user_id=user.id,
        timestamp=now,
        payload={"message": message, "channel": "chat"},
    )
    ev_row = ingest_event(db, chat_event)
    db.commit()
    db.refresh(ev_row)

    user_state = refresh_user_state(db, user.id)
    db.commit()

    fired = evaluate_rules_for_event(db, user.id, chat_event.event_type, ev_row.id)
    orch = run_actions(db, user.id, fired, ev_row.id)
    db.commit()

    treatment_context = {
        "active_treatment_status": user_state.get("active_treatment_status"),
        "notes": "Populate from your EHR / product profile when available.",
    }

    context = build_ai_context(
        user_state=user_state,
        recent_events=_recent_events(db, user.id),
        active_rules=fired,
        treatment_context=treatment_context,
    )
    reply = generate_coaching_response(message, context)

    return {
        "reply": reply,
        "trace": {
            "event_id": ev_row.id,
            "user_state": user_state,
            "fired_rules": fired,
            "action_log_ids": [a.id for a in orch.action_logs],
            "ai_context": context,
        },
    }


def ingest_symptom(
    db: Session,
    user: User,
    symptom: str,
    severity: int | None = None,
) -> dict[str, Any]:
    ev = CareEvent(
        event_type="symptom_reported",
        user_id=user.id,
        payload={"symptom": symptom, "severity": severity or 0},
    )
    row = ingest_event(db, ev)
    db.commit()
    db.refresh(row)

    user_state = refresh_user_state(db, user.id)
    fired = evaluate_rules_for_event(db, user.id, ev.event_type, row.id)
    orch = run_actions(db, user.id, fired, row.id)
    db.commit()

    ctx = build_ai_context(
        user_state=user_state,
        recent_events=_recent_events(db, user.id),
        active_rules=fired,
        treatment_context={"symptom": symptom},
    )
    coach = generate_coaching_response(f"I am experiencing: {symptom}", ctx)

    return {
        "event_id": row.id,
        "user_state": user_state,
        "fired_rules": fired,
        "action_log_ids": [a.id for a in orch.action_logs],
        "coaching_preview": coach,
    }


def record_medication_missed(db: Session, user: User, medication_id: str | None = None) -> dict[str, Any]:
    ev = CareEvent(
        event_type="medication_missed",
        user_id=user.id,
        payload={"medication_id": medication_id},
    )
    row = ingest_event(db, ev)
    db.commit()
    db.refresh(row)

    user_state = refresh_user_state(db, user.id)
    fired = evaluate_rules_for_event(db, user.id, ev.event_type, row.id)
    orch = run_actions(db, user.id, fired, row.id)
    db.commit()

    return {
        "event_id": row.id,
        "user_state": user_state,
        "fired_rules": fired,
        "action_log_ids": [a.id for a in orch.action_logs],
    }


def record_consult_completed(db: Session, user: User, summary: str | None = None) -> dict[str, Any]:
    ev = CareEvent(
        event_type="consult_completed",
        user_id=user.id,
        payload={"summary": summary or ""},
    )
    row = ingest_event(db, ev)
    db.commit()
    db.refresh(row)

    user_state = refresh_user_state(db, user.id)
    fired = evaluate_rules_for_event(db, user.id, ev.event_type, row.id)
    orch = run_actions(db, user.id, fired, row.id)
    db.commit()

    ctx = build_ai_context(
        user_state=user_state,
        recent_events=_recent_events(db, user.id),
        active_rules=fired,
        treatment_context={"consult": "completed"},
    )
    coach = generate_coaching_response("I just finished my consult.", ctx)

    return {
        "event_id": row.id,
        "user_state": user_state,
        "fired_rules": fired,
        "action_log_ids": [a.id for a in orch.action_logs],
        "onboarding_coaching_preview": coach,
    }


def get_state_view(db: Session, user: User) -> dict[str, Any]:
    return get_user_state_snapshot(db, user.id)
