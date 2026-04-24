from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.core.actions import ActionContext, run_actions
from backend.core.db.models import Event, Rule, UserState
from backend.core.events import CareEventCreate, ingest_event
from backend.core.rules import evaluate_rules_for_event
from backend.core.state import apply_event_to_state
from backend.coach.contextual import contextual_coach_reply
from backend.coach.legacy_chat import build_ai_context


def _state_to_dict(state: UserState) -> dict[str, Any]:
    return {
        "adherence_score": state.adherence_score,
        "risk_level": state.risk_level,
        "active_treatment_status": state.active_treatment_status,
        "last_lab_summary": state.last_lab_summary,
        "last_interaction_at": state.last_interaction_at.isoformat() if state.last_interaction_at else None,
    }


def _recent_events(session: Session, user_id: str, limit: int = 10) -> list[dict[str, Any]]:
    q = (
        select(Event)
        .where(Event.user_id == user_id)
        .order_by(Event.timestamp.desc())
        .limit(limit)
    )
    rows = list(session.scalars(q))
    out = []
    for ev in reversed(rows):
        out.append(
            {
                "id": ev.id,
                "event_type": ev.event_type,
                "timestamp": ev.timestamp.isoformat(),
                "payload": ev.payload or {},
            }
        )
    return out


def process_user_chat_message(
    session: Session,
    user_id: str,
    user_message: str,
    history: list[dict[str, str]],
) -> dict[str, Any]:
    """
    Chat flow: event → state → rules → actions → contextual AI.
    Returns trace + assistant text.
    """
    # 1. Event: user message
    msg_event = ingest_event(
        session,
        CareEventCreate(event_type="user_message", user_id=user_id, payload={"text": user_message}),
    )
    session.flush()

    # 2. State
    state = apply_event_to_state(session, user_id, "user_message", {"text": user_message})

    # 3–4. Rules + actions
    matches = evaluate_rules_for_event(session, user_id, "user_message", state)
    ctx = ActionContext(session=session, user_id=user_id, related_event_id=msg_event.id)
    active_rules: list[dict[str, Any]] = []
    for rule, actions in matches:
        active_rules.append({"rule_id": rule.id, "name": rule.name, "actions": actions})
        run_actions(ctx, actions, extra={"ai_hint": rule.name})

    # Build AI context (after rules so hints are populated)
    treatment_context = {
        "flags": [a for r in active_rules for a in r.get("actions", [])],
        "sms_stubbed": ctx.sms_queue,
        "webhooks_stubbed": ctx.webhook_log,
    }
    ai_context = build_ai_context(
        user_state=_state_to_dict(state),
        recent_events=_recent_events(session, user_id),
        active_rules=active_rules,
        treatment_context=treatment_context,
    )

    # 5. AI response
    text = contextual_coach_reply(user_message, history, ai_context, ctx.coaching_hints)

    asst_event = ingest_event(
        session,
        CareEventCreate(
            event_type="assistant_message",
            user_id=user_id,
            payload={
                "text": text,
                "trace": {
                    "trigger_event_id": msg_event.id,
                    "active_rule_ids": [r["rule_id"] for r in active_rules],
                    "actions_log_context": "see actions_log table",
                },
            },
        ),
    )
    apply_event_to_state(session, user_id, "assistant_message", {"text": text})
    session.flush()

    return {
        "reply": text,
        "trace": {
            "user_message_event_id": msg_event.id,
            "assistant_message_event_id": asst_event.id,
            "user_state": ai_context["user_state"],
            "active_rules": active_rules,
            "coaching_hints": ctx.coaching_hints,
        },
    }


def process_structured_event(
    session: Session,
    data: CareEventCreate,
    extra_action_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Ingest non-chat events (symptoms, labs, adherence, consults)."""
    ev = ingest_event(session, data)
    session.flush()

    state = apply_event_to_state(session, data.user_id, data.event_type, data.payload or {})
    matches = evaluate_rules_for_event(session, data.user_id, data.event_type, state)
    ctx = ActionContext(session=session, user_id=data.user_id, related_event_id=ev.id)
    active_rules: list[dict[str, Any]] = []
    for rule, actions in matches:
        active_rules.append({"rule_id": rule.id, "name": rule.name, "actions": actions})
        hint = f"Rule '{rule.name}' fired for {data.event_type}."
        run_actions(ctx, actions, extra={**(extra_action_context or {}), "ai_hint": hint})

    # Optional proactive assistant message when rules request send_ai_message
    assistant_event_id = None
    if ctx.coaching_hints:
        body = "Care update: " + " ".join(ctx.coaching_hints)
        asst = ingest_event(
            session,
            CareEventCreate(
                event_type="assistant_message",
                user_id=data.user_id,
                payload={"text": body, "trace": {"trigger_event_id": ev.id, "proactive": True}},
            ),
        )
        session.flush()
        assistant_event_id = asst.id
        apply_event_to_state(session, data.user_id, "assistant_message", {"text": body})

    session.flush()
    return {
        "event_id": ev.id,
        "user_state": _state_to_dict(state),
        "active_rules": active_rules,
        "actions": {
            "coaching_hints": ctx.coaching_hints,
            "sms": ctx.sms_queue,
            "webhooks": ctx.webhook_log,
        },
        "assistant_message_event_id": assistant_event_id,
    }


def seed_default_rules(session: Session) -> None:
    existing = session.scalar(select(Rule).limit(1))
    if existing:
        return

    defaults = [
        {
            "name": "Escalate repeated missed medications",
            "definition": {
                "event_type": "medication_missed",
                "conditions": {"count_last_7_days": "> 2"},
                "actions": [
                    "send_ai_message",
                    "schedule_checkin",
                    "notify_clinician",
                    "send_sms",
                    "pharmacy_trigger",
                ],
            },
        },
        {
            "name": "Coach on new symptom report",
            "definition": {
                "event_type": "symptom_reported",
                "conditions": {},
                "actions": ["send_ai_message"],
            },
        },
        {
            "name": "Onboarding after consult",
            "definition": {
                "event_type": "consult_completed",
                "conditions": {},
                "actions": ["send_ai_message", "openloop_notify"],
            },
        },
    ]
    for row in defaults:
        session.add(Rule(name=row["name"], definition=row["definition"], enabled=True))
    session.flush()
