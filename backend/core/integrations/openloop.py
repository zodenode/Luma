"""OpenLoop telehealth — webhook stub."""

from typing import Any


def notify(payload: dict[str, Any]) -> dict[str, Any]:
    return {"status": "stub", "provider": "openloop", "payload_echo": payload}
