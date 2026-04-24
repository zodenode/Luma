def notify(payload: dict) -> str:
    """OpenLoop telehealth webhook stub."""
    return f"openloop_webhook_stub:{payload.get('user_id')}"
