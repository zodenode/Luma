from __future__ import annotations

from typing import Any


def trigger_pharmacy(user_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Stub: pharmacy fulfillment API."""
    return {"provider": "pharmacy", "user_id": user_id, "status": "stub_accepted", "payload": payload}
