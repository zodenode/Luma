from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class CareEventIn(BaseModel):
    """Inbound care event (append-only)."""

    event_type: str = Field(..., examples=["symptom_reported", "medication_missed"])
    user_id: str
    timestamp: datetime | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


class CareEventOut(BaseModel):
    id: str
    event_type: str
    user_id: str
    timestamp: datetime
    payload: dict[str, Any]

    model_config = {"from_attributes": True}


class UserStateOut(BaseModel):
    user_id: str
    adherence_score: float
    risk_level: str
    active_treatment_status: str
    last_lab_summary: str | None
    last_interaction_at: datetime | None
    updated_at: datetime

    model_config = {"from_attributes": True}


class ChatMessageIn(BaseModel):
    """Backward-compatible chat: same shape as a simple coaching chat."""

    user_id: str
    message: str
    treatment_context: dict[str, Any] | None = None


class ChatMessageOut(BaseModel):
    reply: str
    event_id: str
    trace: dict[str, Any]


class RuleIn(BaseModel):
    name: str
    enabled: bool = True
    definition: dict[str, Any]


class RuleOut(BaseModel):
    id: str
    name: str
    enabled: bool
    definition: dict[str, Any]

    model_config = {"from_attributes": True}


class ActionLogOut(BaseModel):
    id: str
    user_id: str
    event_id: str | None
    rule_id: str | None
    action_type: str
    status: str
    detail: dict[str, Any]
    created_at: datetime

    model_config = {"from_attributes": True}
