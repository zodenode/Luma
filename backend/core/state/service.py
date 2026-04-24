from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from backend.core.db.models import Event, UserState


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def get_or_create_state(session: Session, user_id: str) -> UserState:
    state = session.get(UserState, user_id)
    if state is None:
        state = UserState(user_id=user_id)
        session.add(state)
        session.flush()
    return state


def _count_events(
    session: Session,
    user_id: str,
    event_type: str,
    since: datetime,
) -> int:
    q = (
        select(func.count())
        .select_from(Event)
        .where(
            Event.user_id == user_id,
            Event.event_type == event_type,
            Event.timestamp >= since,
        )
    )
    return int(session.scalar(q) or 0)


def apply_event_to_state(session: Session, user_id: str, event_type: str, payload: dict[str, Any] | None) -> UserState:
    """Materialise user_state snapshot after an event."""
    state = get_or_create_state(session, user_id)
    now = _utcnow()
    payload = payload or {}

    state.last_interaction_at = now

    if event_type == "user_message":
        pass

    elif event_type == "symptom_reported":
        severity = str(payload.get("severity", "low")).lower()
        if severity in ("high", "severe", "emergency"):
            state.risk_level = "high"
        elif severity == "moderate":
            state.risk_level = max_risk(state.risk_level, "medium")
        else:
            state.risk_level = max_risk(state.risk_level, "low")

    elif event_type == "medication_missed":
        since = now - timedelta(days=7)
        misses = _count_events(session, user_id, "medication_missed", since)
        # Adherence heuristic: more misses -> lower score
        state.adherence_score = max(0.0, 1.0 - 0.12 * min(misses, 7))
        if misses > 2:
            state.risk_level = max_risk(state.risk_level, "high")
        elif misses > 0:
            state.risk_level = max_risk(state.risk_level, "medium")

    elif event_type == "medication_taken":
        state.adherence_score = min(1.0, state.adherence_score + 0.05)

    elif event_type == "consult_completed":
        state.active_treatment_status = payload.get("next_status", "onboarding")

    elif event_type == "lab_result":
        state.last_lab_summary = {
            "summary": payload.get("summary"),
            "markers": payload.get("markers"),
            "received_at": now.isoformat(),
        }

    session.flush()
    return state


def max_risk(current: str, candidate: str) -> str:
    order = {"low": 0, "medium": 1, "high": 2}
    levels = {v: k for k, v in order.items()}
    return levels[max(order.get(current, 0), order.get(candidate, 0))]
