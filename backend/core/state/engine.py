from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from backend.models import Event, UserState


def get_or_create_state(db: Session, user_id: str) -> UserState:
    row = db.get(UserState, user_id)
    if row:
        return row
    row = UserState(user_id=user_id)
    db.add(row)
    db.flush()
    return row


def _count_missed_meds(db: Session, user_id: str, since: datetime) -> int:
    q = (
        select(func.count())
        .select_from(Event)
        .where(Event.user_id == user_id, Event.event_type == "medication_missed", Event.timestamp >= since)
    )
    return int(db.scalar(q) or 0)


def apply_event_to_state(db: Session, user_id: str, event_type: str, event_ts: datetime) -> UserState:
    """
    Materialise user_state snapshot after an event (MVP heuristics).
    """
    state = get_or_create_state(db, user_id)
    state.last_interaction_at = event_ts
    state.updated_at = datetime.now(timezone.utc)

    if event_type == "chat_message":
        pass
    elif event_type == "symptom_reported":
        state.risk_level = "elevated"
    elif event_type == "medication_taken":
        state.adherence_score = min(1.0, state.adherence_score + 0.05)
    elif event_type == "medication_missed":
        state.adherence_score = max(0.0, state.adherence_score - 0.15)
        since = event_ts - timedelta(days=7)
        misses = _count_missed_meds(db, user_id, since)
        if misses > 2:
            state.risk_level = "high"
        elif misses > 0:
            state.risk_level = "moderate"
    elif event_type == "consult_completed":
        state.active_treatment_status = "onboarding"
        state.risk_level = "low"
    elif event_type == "lab_result":
        state.last_lab_summary = "Lab received (MVP placeholder summary)"

    db.flush()
    return state
