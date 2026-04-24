def enqueue_alert(payload: dict) -> str:
    """Clinician alert queue stub."""
    return f"clinician_queue_stub:{payload.get('user_id')}:{payload.get('reason', 'alert')}"
