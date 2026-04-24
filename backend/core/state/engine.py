from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Event, User, UserState


def get_or_create_state(db: Session, user: User) -> UserState:
    st = db.get(UserState, user.id)
    if st:
        return st
    st = UserState(
        user_id=user.id,
        adherence_score=1.0,
        risk_level="low",
        active_treatment_status="none",
        last_lab_summary=None,
        last_interaction_at=None,
        snapshot={},
    )
    db.add(st)
    db.flush()
    return st


def _count_events(
    db: Session, user_id: int, event_type: str, since: datetime
) -> int:
    q = select(func.count()).select_from(Event).where(
        Event.user_id == user_id,
        Event.event_type == event_type,
        Event.timestamp >= since,
    )
    return int(db.execute(q).scalar_one())


def apply_event_to_state(db: Session, user: User, event: Event) -> UserState:
    """Update materialised user state after an event."""
    st = get_or_create_state(db, user)
    st.last_interaction_at = event.timestamp

    p = event.payload or {}
    et = event.event_type

    if et == "chat_message":
        st.snapshot = {**st.snapshot, "last_chat_topic": p.get("topic")}

    elif et == "symptom_reported":
        severity = str(p.get("severity", "moderate")).lower()
        if severity in ("severe", "high"):
            st.risk_level = "high"
        elif severity in ("moderate", "medium") and st.risk_level == "low":
            st.risk_level = "medium"
        st.snapshot = {
            **st.snapshot,
            "last_symptom": p.get("symptom"),
            "last_symptom_severity": severity,
        }

    elif et == "medication_missed":
        st.adherence_score = max(0.0, st.adherence_score - 0.15)
        missed_7d = _count_events(
            db, user.id, "medication_missed", event.timestamp - timedelta(days=7)
        )
        if missed_7d > 2:
            st.risk_level = "high"
        elif missed_7d > 0 and st.risk_level == "low":
            st.risk_level = "medium"

    elif et in ("medication_taken", "adherence_update"):
        st.adherence_score = min(1.0, st.adherence_score + 0.05)
        if p.get("on_track") is True and st.risk_level != "high":
            st.risk_level = "low"

    elif et == "consult_completed":
        st.active_treatment_status = p.get("flow", "onboarding")
        st.snapshot = {**st.snapshot, "last_consult_id": p.get("consult_id")}

    elif et == "lab_result":
        st.last_lab_summary = {
            "summary": p.get("summary"),
            "markers": p.get("markers", {}),
            "received_at": event.timestamp.isoformat(),
        }

    st.updated_at = datetime.utcnow()
    db.add(st)
    db.flush()
    return st
