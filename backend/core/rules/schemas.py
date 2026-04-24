from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class RuleDefinition(BaseModel):
    """JSON rule shape (v1)."""

    event_type: str
    conditions: dict[str, Any] = Field(default_factory=dict)
    actions: list[str] = Field(default_factory=list)
