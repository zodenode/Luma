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
    return get_user_state_snapshot(db, user.id)


def record_daily_checkin(
    db: Session,
    user: User,
    mood: int | None = None,
    energy: int | None = None,
    notes: str | None = None,
    recorded_at: datetime | None = None,
    payload_extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    ts = recorded_at or datetime.now(timezone.utc)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    body: dict[str, Any] = {"mood": mood, "energy": energy, "notes": notes or ""}
    if payload_extra:
        body.update(payload_extra)
    ev = CareEvent(
        event_type="daily_checkin_completed",
        user_id=user.id,
        timestamp=ts,
        payload=body,
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


def record_weekly_reflection(
    db: Session,
    user: User,
    what_changed: str | None = None,
    wins: str | None = None,
    struggles: str | None = None,
    week_label: str | None = None,
    notes: str | None = None,
) -> dict[str, Any]:
    ev = CareEvent(
        event_type="weekly_reflection_recorded",
        user_id=user.id,
        payload={
            "week_label": week_label or "",
            "what_changed": what_changed or "",
            "wins": wins or "",
            "struggles": struggles or "",
            "notes": notes or "",
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
        treatment_context=_treatment_context_from_state(user_state, {"weekly_reflection": True}),
    )
    coach = generate_coaching_response(
        "I logged my weekly reflection: what changed, wins, and struggles.",
        ctx,
    )

    return {
        "event_id": row.id,
        "user_state": user_state,
        "fired_rules": fired,
        "action_log_ids": [a.id for a in orch.action_logs],
        "coaching_preview": coach,
    }


def record_clinical_metric(
    db: Session,
    user: User,
    series_key: str,
    value: float,
    unit: str | None = None,
    observed_at: str | None = None,
    source_platform: str | None = None,
    label: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "series_key": series_key,
        "value": value,
        "unit": unit or "",
        "label": label or "",
        "source_platform": source_platform or "",
    }
    if observed_at:
        payload["observed_at"] = observed_at
    ev = CareEvent(
        event_type="clinical_metric_recorded",
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

    return {
        "event_id": row.id,
        "user_state": user_state,
        "fired_rules": fired,
        "action_log_ids": [a.id for a in orch.action_logs],
    }


def record_external_sync(
    db: Session,
    user: User,
    resource_type: str,
    platform: str | None = None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "resource_type": resource_type,
        "platform": platform or "",
    }
    if payload:
        body.update(payload)
    ev = CareEvent(
        event_type="external_sync_recorded",
        user_id=user.id,
        payload=body,
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


def get_retention_dashboard_view(db: Session, user: User) -> dict[str, Any]:
    """Structured view for dashboards: state rollups plus recent metric events."""
    state = refresh_user_state(db, user.id)
    db.commit()
    metric_events = db.scalars(
        select(Event)
        .where(Event.user_id == user.id, Event.event_type == "clinical_metric_recorded")
        .order_by(Event.timestamp.desc())
        .limit(80)
    ).all()
    series_points: list[dict[str, Any]] = []
    for r in reversed(metric_events):
        ts = r.timestamp
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        p = r.payload if isinstance(r.payload, dict) else {}
        series_points.append(
            {
                "timestamp": ts.isoformat(),
                "series_key": p.get("series_key"),
                "value": p.get("value"),
                "unit": p.get("unit"),
                "source_platform": p.get("source_platform"),
            }
        )
    return {
        "user_external_id": user.external_id,
        "snapshot": state,
        "clinical_metric_timeline": series_points,
    }


def _treatment_context_from_state(user_state: dict[str, Any], extra: dict[str, Any] | None = None) -> dict[str, Any]:
    refs = user_state.get("weekly_reflections") or []
    if isinstance(refs, list):
        ref_tail = [r for r in refs[:3] if isinstance(r, dict)]
    else:
        ref_tail = []
    costs = user_state.get("cost_timeline") or []
    if isinstance(costs, list):
        cost_tail = [c for c in costs[-6:] if isinstance(c, dict)]
    else:
        cost_tail = []
    series = user_state.get("clinical_series") or {}
    series_keys = list(series.keys()) if isinstance(series, dict) else []

    out: dict[str, Any] = {
        "active_treatment_status": user_state.get("active_treatment_status"),
        "prescription_schedule": user_state.get("prescription_schedule"),
        "retention": user_state.get("retention") or {},
        "clinical_series_keys": series_keys,
        "weekly_reflections_tail": ref_tail,
        "correlation_hints": user_state.get("correlation_hints") or [],
        "cost_timeline_tail": cost_tail,
        "notes": "Populate from your EHR / product profile when available.",
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
