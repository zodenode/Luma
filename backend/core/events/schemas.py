from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class CareEventCreate(BaseModel):
    event_type: str = Field(..., examples=["symptom_reported"])
    user_id: str = Field(..., description="External user identifier")
    timestamp: datetime | None = Field(
        default=None, description="Defaults to server time if omitted"
    )
    payload: dict[str, Any] = Field(default_factory=dict)


class CareEventResponse(BaseModel):
    id: int
    event_type: str
    user_id: str
    timestamp: datetime
    payload: dict[str, Any]

    model_config = {"from_attributes": True}
