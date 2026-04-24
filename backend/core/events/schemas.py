from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class CareEventCreate(BaseModel):
    """Inbound care event (append-only)."""

    event_type: str = Field(..., examples=["symptom_reported"])
    user_id: str
    timestamp: datetime | None = None
    payload: dict[str, Any] = Field(default_factory=dict)

    def resolved_timestamp(self) -> datetime:
        return self.timestamp or _utcnow()
