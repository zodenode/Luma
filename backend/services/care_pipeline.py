from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.ai.coaching import build_ai_context, generate_coaching_response
from backend.core.actions import run_actions
from backend.core.events import CareEvent, ingest_event
from backend.core.models import Event, User
from backend.core.rules import evaluate_rules_for_event
from backend.core.scheduling import PrescriptionSchedulePayload
from backend.core.state import get_user_state_snapshot, refresh_user_state


def get_or_create_user(db: Session, external_user_id: str) -> User:
    row = db.scalar(select(User).where(User.external_id == external_user_id))
    if row:
        return row
    u = User(external_id=external_user_id)
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _recent_events(db: Session, user_id: str, limit: int = 40) -> list[dict[str, Any]]:
    rows = db.scalars(
        select(Event)
        .where(Event.user_id == user_id)
        .order_by(Event.timestamp.desc())
        .limit(limit)
    ).all()
    out: list[dict[str, Any]] = []
    for r in reversed(rows):
        ts = r.timestamp
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        out.append(
            {
                "id": r.id,
                "event_type": r.event_type,
                "timestamp": ts.isoformat(),
                "payload": r.payload,
            }
        )
    return out


def process_chat_turn(
    db: Session,
    user: User,
    message: str,
) -> dict[str, Any]:
    """
    Chat flow: event → state → rules → actions → AI (wrapped).
    """
    now = datetime.now(timezone.utc)

    chat_event = CareEvent(
        event_type="chat_message_received",
        user_id=user.id,
        timestamp=now,
        payload={"message": message, "channel": "chat"},
    )
    ev_row = ingest_event(db, chat_event)
    db.commit()
    db.refresh(ev_row)

    user_state = refresh_user_state(db, user.id)
    db.commit()

    fired = evaluate_rules_for_event(db, user.id, chat_event.event_type, ev_row.id)
    orch = run_actions(db, user.id, fired, ev_row.id)
    db.commit()

    treatment_context = _treatment_context_from_state(user_state)

    context = build_ai_context(
        user_state=user_state,
        recent_events=_recent_events(db, user.id),
        active_rules=fired,
        treatment_context=treatment_context,
    )
    reply = generate_coaching_response(message, context)

    return {
        "reply": reply,
        "trace": {
            "event_id": ev_row.id,
            "user_state": user_state,
            "fired_rules": fired,
            "action_log_ids": [a.id for a in orch.action_logs],
            "ai_context": context,
        },
    }


def ingest_symptom(
    db: Session,
    user: User,
    symptom: str,
    severity: int | None = None,
) -> dict[str, Any]:
    ev = CareEvent(
        event_type="symptom_reported",
        user_id=user.id,
        payload={"symptom": symptom, "severity": severity or 0},
    )
    row = ingest_event(db, ev)
    db.commit()
    db.refresh(row)

    user_state = refresh_user_state(db, user.id)
    fired = evaluate_rules_for_event(db, user.id, ev.event_type, row.id)
    orch = run_actions(db, user.id, fired, row.id)
    db.commit()

    ctx = build_ai_context(
        user_state=user_state,
        recent_events=_recent_events(db, user.id),
        active_rules=fired,
        treatment_context=_treatment_context_from_state(user_state, {"symptom": symptom}),
    )
    coach = generate_coaching_response(f"I am experiencing: {symptom}", ctx)

    return {
        "event_id": row.id,
        "user_state": user_state,
        "fired_rules": fired,
        "action_log_ids": [a.id for a in orch.action_logs],
        "coaching_preview": coach,
    }


def record_medication_missed(db: Session, user: User, medication_id: str | None = None) -> dict[str, Any]:
    ev = CareEvent(
        event_type="medication_missed",
        user_id=user.id,
        payload={"medication_id": medication_id},
    )
    row = ingest_event(db, ev)
    db.commit()
    db.refresh(row)

    user_state = refresh_user_state(db, user.id)
    fired = evaluate_rules_for_event(db, user.id, ev.event_type, row.id)
    orch = run_actions(db, user.id, fired, row.id)
    db.commit()

    return {
        "event_id": row.id,
        "user_state": user_state,
        "fired_rules": fired,
        "action_log_ids": [a.id for a in orch.action_logs],
    }


def record_consult_completed(db: Session, user: User, summary: str | None = None) -> dict[str, Any]:
    ev = CareEvent(
        event_type="consult_completed",
        user_id=user.id,
        payload={"summary": summary or ""},
    )
    row = ingest_event(db, ev)
    db.commit()
    db.refresh(row)

    user_state = refresh_user_state(db, user.id)
    fired = evaluate_rules_for_event(db, user.id, ev.event_type, row.id)
    orch = run_actions(db, user.id, fired, row.id)
    db.commit()

    ctx = build_ai_context(
        user_state=user_state,
        recent_events=_recent_events(db, user.id),
        active_rules=fired,
        treatment_context=_treatment_context_from_state(user_state, {"consult": "completed"}),
    )
    coach = generate_coaching_response("I just finished my consult.", ctx)

    return {
        "event_id": row.id,
        "user_state": user_state,
        "fired_rules": fired,
        "action_log_ids": [a.id for a in orch.action_logs],
        "onboarding_coaching_preview": coach,
    }


def get_state_view(db: Session, user: User) -> dict[str, Any]:
    snap = get_user_state_snapshot(db, user.id)
    out: dict[str, Any] = dict(snap)
    out["user_external_id"] = user.external_id
    out["retention_timeline"] = _retention_timeline(db, user.id, limit=120)
    return out


def _retention_timeline(db: Session, user_id: str, limit: int = 120) -> list[dict[str, Any]]:
    types = ("daily_check_in", "series_measurement", "weekly_reflection")
    rows = db.scalars(
        select(Event)
        .where(Event.user_id == user_id, Event.event_type.in_(types))
        .order_by(Event.timestamp.desc())
        .limit(limit)
    ).all()
    out: list[dict[str, Any]] = []
    for r in reversed(rows):
        ts = r.timestamp
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        out.append(
            {
                "id": r.id,
                "event_type": r.event_type,
                "timestamp": ts.isoformat(),
                "payload": r.payload,
            }
        )
    return out


def record_daily_check_in(
    db: Session,
    user: User,
    mood: int | None = None,
    note: str | None = None,
    date_local: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    if mood is not None:
        payload["mood"] = mood
    if note:
        payload["note"] = note[:4000]
    if date_local:
        payload["date_local"] = date_local
    ev = CareEvent(
        event_type="daily_check_in",
        user_id=user.id,
        payload=payload,
    )
    row = ingest_event(db, ev)
    db.commit()
    db.refresh(row)

    user_state = refresh_user_state(db, user.id)
    fired = evaluate_rules_for_event(db, user.id, ev.event_type, row.id)
    orch = run_actions(db, user.id, fired, row.id)
    db.commit()

    ctx = build_ai_context(
        user_state=user_state,
        recent_events=_recent_events(db, user.id),
        active_rules=fired,
        treatment_context=_treatment_context_from_state(user_state, {"touchpoint": "daily_check_in"}),
    )
    coach = generate_coaching_response("I completed my daily check-in.", ctx)

    return {
        "event_id": row.id,
        "user_state": user_state,
        "fired_rules": fired,
        "action_log_ids": [a.id for a in orch.action_logs],
        "coaching_preview": coach,
    }


def record_series_measurement(
    db: Session,
    user: User,
    series_id: str,
    value: float,
    unit: str | None = None,
    source: str | None = None,
    label: str | None = None,
) -> dict[str, Any]:
    ev = CareEvent(
        event_type="series_measurement",
        user_id=user.id,
        payload={
            "series_id": series_id,
            "value": value,
            "unit": unit or "",
            "source": source or "patient_entered",
            "label": label,
        },
    )
    row = ingest_event(db, ev)
    db.commit()
    db.refresh(row)

    user_state = refresh_user_state(db, user.id)
    fired = evaluate_rules_for_event(db, user.id, ev.event_type, row.id)
    orch = run_actions(db, user.id, fired, row.id)
    db.commit()

    ctx = build_ai_context(
        user_state=user_state,
        recent_events=_recent_events(db, user.id),
        active_rules=fired,
        treatment_context=_treatment_context_from_state(
            user_state, {"touchpoint": "series_measurement", "series_id": series_id}
        ),
    )
    coach = generate_coaching_response(
        f"I logged {series_id}: {value}" + (f" {unit}" if unit else "") + ".",
        ctx,
    )

    return {
        "event_id": row.id,
        "user_state": user_state,
        "fired_rules": fired,
        "action_log_ids": [a.id for a in orch.action_logs],
        "coaching_preview": coach,
    }


def record_weekly_reflection(
    db: Session,
    user: User,
    text: str,
    week_index: int | None = None,
    theme: str | None = None,
    tags: list[str] | None = None,
) -> dict[str, Any]:
    ev = CareEvent(
        event_type="weekly_reflection",
        user_id=user.id,
        payload={
            "text": text[:8000],
            "week_index": week_index,
            "theme": theme,
            "tags": tags or [],
        },
    )
    row = ingest_event(db, ev)
    db.commit()
    db.refresh(row)

    user_state = refresh_user_state(db, user.id)
    fired = evaluate_rules_for_event(db, user.id, ev.event_type, row.id)
    orch = run_actions(db, user.id, fired, row.id)
    db.commit()

    ctx = build_ai_context(
        user_state=user_state,
        recent_events=_recent_events(db, user.id),
        active_rules=fired,
        treatment_context=_treatment_context_from_state(user_state, {"touchpoint": "weekly_reflection"}),
    )
    coach = generate_coaching_response(
        "This week I want to reflect on what I did differently: " + text[:500],
        ctx,
    )

    return {
        "event_id": row.id,
        "user_state": user_state,
        "fired_rules": fired,
        "action_log_ids": [a.id for a in orch.action_logs],
        "coaching_preview": coach,
    }


def _treatment_context_from_state(user_state: dict[str, Any], extra: dict[str, Any] | None = None) -> dict[str, Any]:
    retention = user_state.get("retention") if isinstance(user_state, dict) else None
    out: dict[str, Any] = {
        "active_treatment_status": user_state.get("active_treatment_status"),
        "prescription_schedule": user_state.get("prescription_schedule"),
        "notes": "Populate from your EHR / product profile when available.",
        "retention_summary": retention,
        "weekly_reflections_recent": (retention or {}).get("weekly_reflections_recent")
        if isinstance(retention, dict)
        else [],
        "longitudinal_correlations": (retention or {}).get("correlations")
        if isinstance(retention, dict)
        else [],
    }
    if extra:
        out.update(extra)
    return out


def set_prescription_schedule(
    db: Session,
    user: User,
    schedule: PrescriptionSchedulePayload,
) -> dict[str, Any]:
    """
    Persist the full prescription schedule as an append-only event; state picks up latest.
    """
    ev = CareEvent(
        event_type="prescription_schedule_set",
        user_id=user.id,
        payload=schedule.model_dump(mode="json"),
    )
    row = ingest_event(db, ev)
    db.commit()
    db.refresh(row)

    user_state = refresh_user_state(db, user.id)
    fired = evaluate_rules_for_event(db, user.id, ev.event_type, row.id)
    orch = run_actions(db, user.id, fired, row.id)
    db.commit()

    return {
        "event_id": row.id,
        "user_state": user_state,
        "fired_rules": fired,
        "action_log_ids": [a.id for a in orch.action_logs],
    }
