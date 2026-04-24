from datetime import datetime, timezone

from sqlalchemy.orm import Session

from backend.core.schemas import CareEventIn
from backend.models import Event, User


def _ensure_user(db: Session, user_id: str) -> User:
    user = db.query(User).filter(User.id == user_id).first()
    if user:
        return user
    user = User(id=user_id, external_id=None)
    db.add(user)
    db.flush()
    return user


def ingest_event(db: Session, data: CareEventIn) -> Event:
    """Persist an append-only care event."""
    _ensure_user(db, data.user_id)
    ts = data.timestamp or datetime.now(timezone.utc)
    row = Event(user_id=data.user_id, event_type=data.event_type, timestamp=ts, payload=data.payload or {})
    db.add(row)
    db.flush()
    return row
