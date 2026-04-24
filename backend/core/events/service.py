from __future__ import annotations

from sqlalchemy.orm import Session

from backend.core.db.models import Event, User
from backend.core.events.schemas import CareEventCreate


def _ensure_user(session: Session, user_id: str) -> User:
    user = session.get(User, user_id)
    if user is None:
        user = User(id=user_id)
        session.add(user)
        session.flush()
    return user


def ingest_event(session: Session, data: CareEventCreate) -> Event:
    """Persist a single care event (append-only)."""
    _ensure_user(session, data.user_id)
    ev = Event(
        user_id=data.user_id,
        event_type=data.event_type,
        timestamp=data.resolved_timestamp(),
        payload=data.payload or None,
    )
    session.add(ev)
    session.flush()
    return ev
