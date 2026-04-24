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

    retention = user_state.get("retention") or {}
    longit = retention.get("longitudinal") if isinstance(retention, dict) else {}
    last_ref = longit.get("last_weekly_reflection") if isinstance(longit, dict) else None
    extra_ctx: dict[str, Any] = {}
    if isinstance(last_ref, dict) and last_ref.get("differences_noted"):
        extra_ctx["last_weekly_reflection_summary"] = {
            "week_label": last_ref.get("week_label"),
            "differences_noted": last_ref.get("differences_noted"),
            "focus_area": last_ref.get("focus_area"),
            "recorded_at": last_ref.get("timestamp"),
        }
    treatment_context = _treatment_context_from_state(user_state, extra_ctx)

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


def _treatment_context_from_state(user_state: dict[str, Any], extra: dict[str, Any] | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {
        "active_treatment_status": user_state.get("active_treatment_status"),
        "prescription_schedule": user_state.get("prescription_schedule"),
        "retention": user_state.get("retention"),
        "notes": "Populate from your EHR / product profile when available.",
    }
    if extra:
        out.update(extra)
    return out


def _start_of_utc_day(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    return dt.replace(hour=0, minute=0, second=0, microsecond=0)


def _already_daily_checkin_today(db: Session, user_id: str, now: datetime) -> bool:
    start = _start_of_utc_day(now)
    q = (
        select(Event.id)
        .where(
            Event.user_id == user_id,
            Event.event_type == "daily_checkin_completed",
            Event.timestamp >= start,
        )
        .limit(1)
    )
    return db.scalar(q) is not None


def record_daily_checkin(
    db: Session,
    user: User,
    mood: int | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    if _already_daily_checkin_today(db, user.id, now):
        snap = get_user_state_snapshot(db, user.id)
        return {
            "status": "already_completed_today",
            "user_state": snap,
            "fired_rules": [],
            "action_log_ids": [],
        }

    ev = CareEvent(
        event_type="daily_checkin_completed",
        user_id=user.id,
        timestamp=now,
        payload={"mood_1_5": mood, "note": (note or "").strip()[:2000]},
    )
    row = ingest_event(db, ev)
    db.commit()
    db.refresh(row)

    user_state = refresh_user_state(db, user.id)
    fired = evaluate_rules_for_event(db, user.id, ev.event_type, row.id)
    orch = run_actions(db, user.id, fired, row.id)
    db.commit()

    return {
        "status": "recorded",
        "event_id": row.id,
        "user_state": user_state,
        "fired_rules": fired,
        "action_log_ids": [a.id for a in orch.action_logs],
    }


def record_weekly_reflection(
    db: Session,
    user: User,
    differences_noted: str,
    week_label: str | None = None,
    focus_area: str | None = None,
) -> dict[str, Any]:
    ev = CareEvent(
        event_type="weekly_reflection_submitted",
        user_id=user.id,
        payload={
            "differences_noted": differences_noted.strip()[:8000],
            "week_label": (week_label or "").strip()[:128] or None,
            "focus_area": (focus_area or "").strip()[:256] or None,
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
            user_state,
            {"reflection_prompt": "What did you do differently this week?"},
        ),
    )
    coach = generate_coaching_response(
        "I submitted my weekly reflection on what I did differently.",
        ctx,
    )

    return {
        "event_id": row.id,
        "user_state": user_state,
        "fired_rules": fired,
        "action_log_ids": [a.id for a in orch.action_logs],
        "coaching_preview": coach,
    }


def record_biomarker(
    db: Session,
    user: User,
    metric_key: str,
    value: float,
    unit: str | None = None,
    source: str | None = None,
    recorded_at: datetime | None = None,
) -> dict[str, Any]:
    ts = recorded_at or datetime.now(timezone.utc)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)

    ev = CareEvent(
        event_type="biomarker_recorded",
        user_id=user.id,
        timestamp=ts,
        payload={
            "metric_key": metric_key.strip()[:128],
            "value": value,
            "unit": (unit or "").strip()[:32] or None,
            "source": (source or "patient").strip()[:64],
        },
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


def record_cost_quote(
    db: Session,
    user: User,
    amount: float,
    currency: str = "USD",
    reason: str | None = None,
    pharmacy_or_platform: str | None = None,
) -> dict[str, Any]:
    ev = CareEvent(
        event_type="cost_quote_noted",
        user_id=user.id,
        payload={
            "amount": amount,
            "currency": currency.strip()[:8] or "USD",
            "reason": (reason or "").strip()[:512] or None,
            "pharmacy_or_platform": (pharmacy_or_platform or "").strip()[:128] or None,
        },
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


def ingest_external_series(
    db: Session,
    user: User,
    points: list[dict[str, Any]],
    platform: str | None = None,
) -> dict[str, Any]:
    """
    Batch ingest third-party metric points into the same longitudinal stream
    (stored as external_data_ingested with embedded points for correlation).
    """
    batch: list[dict[str, Any]] = []
    for p in points[:200]:
        if not isinstance(p, dict):
            continue
        mk = str(p.get("metric_key") or "").strip()
        if not mk:
            continue
        try:
            val = float(p.get("value"))
        except (TypeError, ValueError):
            continue
        entry: dict[str, Any] = {"metric_key": mk[:128], "value": val}
        raw_ts = p.get("recorded_at")
        if isinstance(raw_ts, str):
            entry["recorded_at"] = raw_ts
        if p.get("unit") is not None:
            entry["unit"] = str(p.get("unit"))[:32]
        batch.append(entry)

    ev = CareEvent(
        event_type="external_data_ingested",
        user_id=user.id,
        payload={
            "platform": (platform or "").strip()[:128] or None,
            "points": batch,
            "count": len(batch),
        },
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
        "ingested_points": len(batch),
        "user_state": user_state,
        "fired_rules": fired,
        "action_log_ids": [a.id for a in orch.action_logs],
    }


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
