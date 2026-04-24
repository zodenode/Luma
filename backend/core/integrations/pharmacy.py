"""Pharmacy fulfillment API — stub."""

from typing import Any


def trigger(payload: dict[str, Any]) -> dict[str, Any]:
    return {"status": "stub", "provider": "pharmacy", "payload_echo": payload}
