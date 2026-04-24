from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field


class CareEvent(BaseModel):
    """Canonical care event envelope (persisted append-only)."""

    event_type: str
    user_id: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    payload: dict[str, Any] = Field(default_factory=dict)
