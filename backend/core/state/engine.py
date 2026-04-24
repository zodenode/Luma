from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.core.models import Event, UserState


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def refresh_user_state(db: Session, user_id: str) -> dict[str, Any]:
    """
    Rebuild materialised user_state snapshot from append-only events.
    MVP: deterministic heuristics from recent event windows.
    """
    now = datetime.now(timezone.utc)
    since_7d = now - timedelta(days=7)
    since_30d = now - timedelta(days=30)

    events = db.scalars(
        select(Event)
        .where(Event.user_id == user_id)
        .order_by(Event.timestamp.desc())
        .limit(500)
    ).all()

    last_interaction: datetime | None = None
    missed_7d = 0
    missed_30d = 0
    last_lab_summary: dict[str, Any] | None = None
    active_treatment = "unknown"
    symptom_severity_max = 0

    interaction_types = {
        "chat_message_received",
        "symptom_reported",
        "medication_taken",
        "medication_missed",
        "consult_completed",
        "lab_result_received",
    }

    for ev in events:
        ts = ev.timestamp
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)

        if ev.event_type in interaction_types:
            if last_interaction is None or ts > last_interaction:
                last_interaction = ts

        if ev.event_type == "medication_missed":
            if ts >= since_7d:
                missed_7d += 1
            if ts >= since_30d:
                missed_30d += 1

        if ev.event_type == "lab_result_received" and last_lab_summary is None:
            last_lab_summary = ev.payload if isinstance(ev.payload, dict) else {"raw": ev.payload}

        if ev.event_type == "treatment_started":
            active_treatment = "active"

        if ev.event_type == "treatment_paused":
            active_treatment = "paused"

        if ev.event_type == "symptom_reported":
            sev = 0
            if isinstance(ev.payload, dict):
                sev = int(ev.payload.get("severity") or 0)
            symptom_severity_max = max(symptom_severity_max, sev)

    adherence_score = max(0.0, min(1.0, 1.0 - (missed_30d / 30.0)))

    risk_level = "low"
    if missed_7d > 2 or symptom_severity_max >= 8:
        risk_level = "high"
    elif missed_7d > 0 or symptom_severity_max >= 4:
        risk_level = "medium"

    snapshot: dict[str, Any] = {
        "adherence_score": round(adherence_score, 3),
        "risk_level": risk_level,
        "active_treatment_status": active_treatment,
        "last_lab_summary": last_lab_summary,
        "last_interaction_timestamp": _iso(last_interaction),
        "metrics": {
            "medication_missed_count_7d": missed_7d,
            "medication_missed_count_30d": missed_30d,
            "symptom_severity_max_recent": symptom_severity_max,
        },
    }

    row = db.get(UserState, user_id)
    if row is None:
        row = UserState(user_id=user_id, snapshot=snapshot, updated_at=now)
        db.add(row)
    else:
        row.snapshot = snapshot
        row.updated_at = now
    db.flush()
    return snapshot


def get_user_state_snapshot(db: Session, user_id: str) -> dict[str, Any]:
    row = db.get(UserState, user_id)
    if row is None:
        return refresh_user_state(db, user_id)
    return dict(row.snapshot)
