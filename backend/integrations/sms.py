from __future__ import annotations


def send_sms_stub(user_id: str, body: str) -> dict[str, str]:
    """Twilio-ready stub: log intent only."""
    return {"provider": "twilio_stub", "user_id": user_id, "body": body, "status": "not_sent"}
