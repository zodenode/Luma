from datetime import datetime

from sqlalchemy.orm import Session

from app.models import Event, User
from core.events.schemas import CareEventCreate


def _get_or_create_user(db: Session, external_id: str) -> User:
    user = db.query(User).filter(User.external_id == external_id).one_or_none()
    if user:
        return user
    user = User(external_id=external_id)
    db.add(user)
    db.flush()
    return user


def persist_event(db: Session, body: CareEventCreate) -> Event:
    user = _get_or_create_user(db, body.user_id)
    ts = body.timestamp or datetime.utcnow()
    ev = Event(
        user_id=user.id,
        event_type=body.event_type,
        timestamp=ts,
        payload=body.payload,
    )
    db.add(ev)
    db.flush()
    return ev


def ingest_event(db: Session, body: CareEventCreate) -> Event:
    """Validate and persist a single care event (append-only)."""
    return persist_event(db, body)
