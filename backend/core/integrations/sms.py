"""SMS (Twilio-ready) — stub."""

from typing import Any


def send_sms(to: str, body: str, meta: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "status": "stub",
        "provider": "twilio_placeholder",
        "to": to,
        "body_preview": body[:120],
        "meta": meta or {},
    }
