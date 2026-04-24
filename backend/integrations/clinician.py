def queue_clinician_alert(user_id: str, context: dict) -> str:
    """In-app / async queue stub for clinician alerts."""
    return f"clinician_queue:{user_id}"
