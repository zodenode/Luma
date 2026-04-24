from __future__ import annotations

from typing import Any


def enqueue_clinician_alert(user_id: str, context: dict[str, Any]) -> dict[str, Any]:
    """Stub: clinician alert queue."""
    return {"queue": "clinician_alerts_stub", "user_id": user_id, "context": context}
