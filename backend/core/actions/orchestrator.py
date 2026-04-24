from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.orm import Session

from backend.core.models import ActionLog
from backend.integrations.clinician import enqueue_alert
from backend.integrations.openloop import notify as openloop_notify
from backend.integrations.pharmacy import trigger as pharmacy_trigger
from backend.integrations.sms import send_sms_stub


@dataclass
class OrchestratorResult:
    action_logs: list[ActionLog] = field(default_factory=list)
    ai_message_hints: list[str] = field(default_factory=list)


def run_actions(
    db: Session,
    user_id: str,
    fired_rules: list[dict[str, Any]],
    triggered_by_event_id: str | None,
) -> OrchestratorResult:
    """
    Execute side effects for fired rules. Always writes actions_log for traceability.
    """
    out = OrchestratorResult()
    seen: set[tuple[str, str]] = set()

    for fr in fired_rules:
        for action in fr.get("actions") or []:
            key = (fr["rule_id"], action)
            if key in seen:
                continue
            seen.add(key)

            payload: dict[str, Any] = {
                "rule_id": fr["rule_id"],
                "rule_name": fr["name"],
                "triggered_by_event_id": triggered_by_event_id or fr.get("triggered_by_event_id"),
            }
            detail: str | None = None
            status = "completed"

            if action == "send_ai_message":
                hint = (
                    "Rule-triggered coaching: address adherence and offer concrete "
                    "next steps; keep tone aligned with risk level."
                )
                out.ai_message_hints.append(hint)
                payload["hint"] = hint
            elif action == "schedule_checkin":
                detail = "checkin_queued_stub"
            elif action == "notify_clinician" or action == "clinician_alert":
                detail = enqueue_alert({"user_id": user_id, "reason": "clinician_alert"})
            elif action == "send_sms":
                detail = send_sms_stub({"user_id": user_id, "template": "care_reminder"})
            elif action == "openloop_notify":
                detail = openloop_notify({"user_id": user_id, "source": "rules_engine"})
            elif action == "pharmacy_trigger":
                detail = pharmacy_trigger({"user_id": user_id, "intent": "fulfillment_review"})
            else:
                status = "skipped"
                detail = f"unknown_action:{action}"

            log = ActionLog(
                user_id=user_id,
                action_type=action,
                payload=payload,
                triggered_by_event_id=triggered_by_event_id or fr.get("triggered_by_event_id"),
                status=status,
                detail=detail,
            )
            db.add(log)
            db.flush()
            out.action_logs.append(log)

    return out
