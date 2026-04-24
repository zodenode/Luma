from __future__ import annotations

from typing import Any


def notify_openloop(user_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Stub: telehealth provider webhook."""
    return {"provider": "openloop", "user_id": user_id, "status": "stub_queued", "payload": payload}
