from sqlalchemy.orm import Session

from backend.core.events.schemas import CareEvent
from backend.core.models import Event


def ingest_event(db: Session, care_event: CareEvent) -> Event:
    """Persist a single care event (append-only)."""
    row = Event(
        user_id=care_event.user_id,
        event_type=care_event.event_type,
        timestamp=care_event.timestamp,
        payload=care_event.payload,
    )
    db.add(row)
    db.flush()
    return row
