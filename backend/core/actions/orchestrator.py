from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.orm import Session

from backend.core.db.models import ActionLog
from backend.integrations.clinician import enqueue_clinician_alert
from backend.integrations.openloop import notify_openloop
from backend.integrations.pharmacy import trigger_pharmacy
from backend.integrations.sms import send_sms_stub


@dataclass
class ActionContext:
    user_id: str
    session: Session
    related_event_id: str | None
    coaching_hints: list[str] = field(default_factory=list)
    sms_queue: list[dict[str, Any]] = field(default_factory=list)
    webhook_log: list[dict[str, Any]] = field(default_factory=list)


def _log(session: Session, user_id: str, action_type: str, payload: dict | None, event_id: str | None) -> None:
    row = ActionLog(
        user_id=user_id,
        action_type=action_type,
        payload=payload,
        related_event_id=event_id,
        status="completed",
    )
    session.add(row)


def run_actions(ctx: ActionContext, actions: list[str], extra: dict[str, Any] | None = None) -> None:
    """Execute side effects for matched rules (stubs where noted)."""
    extra = extra or {}
    for action in actions:
        if action == "send_ai_message":
            hint = extra.get("ai_hint") or "Follow up with supportive coaching."
            ctx.coaching_hints.append(hint)
            _log(ctx.session, ctx.user_id, action, {"hint": hint}, ctx.related_event_id)

        elif action == "schedule_checkin":
            _log(
                ctx.session,
                ctx.user_id,
                action,
                {"scheduled": True, "channel": extra.get("checkin_channel", "in_app")},
                ctx.related_event_id,
            )

        elif action == "notify_clinician":
            body = enqueue_clinician_alert(ctx.user_id, extra)
            _log(ctx.session, ctx.user_id, "clinician_alert", body, ctx.related_event_id)

        elif action == "send_sms":
            msg = extra.get("sms_body", "Care team check-in: please open the app when you can.")
            res = send_sms_stub(ctx.user_id, msg)
            ctx.sms_queue.append(res)
            _log(ctx.session, ctx.user_id, action, res, ctx.related_event_id)

        elif action == "openloop_notify":
            res = notify_openloop(ctx.user_id, extra.get("openloop_payload", {}))
            ctx.webhook_log.append(res)
            _log(ctx.session, ctx.user_id, action, res, ctx.related_event_id)

        elif action == "pharmacy_trigger":
            res = trigger_pharmacy(ctx.user_id, extra.get("pharmacy_payload", {}))
            ctx.webhook_log.append(res)
            _log(ctx.session, ctx.user_id, action, res, ctx.related_event_id)

        else:
            _log(ctx.session, ctx.user_id, action, {"note": "unknown_action_noop"}, ctx.related_event_id)
