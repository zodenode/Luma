def send_sms_stub(payload: dict) -> str:
    """Twilio-ready SMS stub."""
    return f"sms_stub:{payload.get('user_id')}:{payload.get('template')}"
