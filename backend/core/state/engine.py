from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.core.models import Event, UserState
from backend.core.state.retention import (
    aggregate_clinical_series,
    compute_checkin_streak,
    correlation_hints,
    latest_weekly_reflections,
    retention_level,
    retention_xp,
)


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
        "prescription_schedule_set",
        "daily_checkin_completed",
        "weekly_reflection_recorded",
        "clinical_metric_recorded",
        "external_sync_recorded",
    }

    prescription_schedule: dict[str, Any] | None = None
    checkin_dates: set[date] = set()
    cost_points: list[dict[str, Any]] = []

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

        if ev.event_type == "prescription_schedule_set" and prescription_schedule is None:
            prescription_schedule = (
                ev.payload if isinstance(ev.payload, dict) else {"raw": ev.payload}
            )

        if ev.event_type == "daily_checkin_completed":
            ts = ev.timestamp
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            checkin_dates.add(ts.astimezone(timezone.utc).date())

        if ev.event_type == "external_sync_recorded":
            p = ev.payload if isinstance(ev.payload, dict) else {}
            rt = str(p.get("resource_type") or "").lower()
            if rt in ("cost_estimate", "cost", "payment", "copay"):
                ts = ev.timestamp
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=timezone.utc)
                amt = p.get("amount_usd")
                if amt is None and p.get("amount") is not None:
                    try:
                        amt = float(p["amount"])
                    except (TypeError, ValueError):
                        amt = None
                cost_points.append(
                    {
                        "at": ts.isoformat(),
                        "amount": amt,
                        "currency": p.get("currency") or "USD",
                        "platform": p.get("platform"),
                        "label": p.get("label"),
                    }
                )

    adherence_score = max(0.0, min(1.0, 1.0 - (missed_30d / 30.0)))

    risk_level = "low"
    if missed_7d > 2 or symptom_severity_max >= 8:
        risk_level = "high"
    elif missed_7d > 0 or symptom_severity_max >= 4:
        risk_level = "medium"

    today = datetime.now(timezone.utc).date()
    streak = compute_checkin_streak(checkin_dates, today)
    total_checkins = len(checkin_dates)
    xp = retention_xp(total_checkins, streak)
    level = retention_level(xp)

    clinical_rollups = aggregate_clinical_series(events)
    hints = correlation_hints(clinical_rollups)
    reflections = latest_weekly_reflections(events, limit=5)
    cost_timeline = sorted(cost_points, key=lambda x: x["at"])[-24:]

    snapshot: dict[str, Any] = {
        "adherence_score": round(adherence_score, 3),
        "risk_level": risk_level,
        "active_treatment_status": active_treatment,
        "last_lab_summary": last_lab_summary,
        "last_interaction_timestamp": _iso(last_interaction),
        "prescription_schedule": prescription_schedule,
        "metrics": {
            "medication_missed_count_7d": missed_7d,
            "medication_missed_count_30d": missed_30d,
            "symptom_severity_max_recent": symptom_severity_max,
        },
        "retention": {
            "checkin_streak_days": streak,
            "distinct_checkin_days": total_checkins,
            "retention_xp": xp,
            "retention_level": level,
            "last_checkin_date": max(checkin_dates).isoformat() if checkin_dates else None,
        },
        "clinical_series": clinical_rollups,
        "correlation_hints": hints,
        "weekly_reflections": reflections,
        "cost_timeline": cost_timeline,
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
