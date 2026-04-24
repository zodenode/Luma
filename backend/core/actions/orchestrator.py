from sqlalchemy.orm import Session

from backend.integrations.clinician import queue_clinician_alert
from backend.integrations.openloop import notify_openloop
from backend.integrations.pharmacy import trigger_pharmacy
from backend.integrations.sms import send_sms_stub
from backend.models import ActionLog, Rule


def run_actions(
    db: Session,
    *,
    user_id: str,
    event_id: str | None,
    actions: list[str],
    rule: Rule | None,
    context: dict,
) -> list[ActionLog]:
    """Execute rule actions and append to actions_log."""
    logs: list[ActionLog] = []
    rule_id = rule.id if rule else None

    for action in actions:
        detail: dict = {"context_keys": list(context.keys())}
        status = "completed"

        if action == "send_ai_message":
            detail["note"] = "Deferred to AI coaching layer in same request"
            status = "deferred"
        elif action == "schedule_checkin":
            detail["scheduled_for"] = "stub+24h"
        elif action == "notify_clinician":
            detail["queue"] = queue_clinician_alert(user_id, context)
        elif action == "send_sms":
            detail["provider"] = send_sms_stub(user_id, context)
        elif action == "openloop_notify":
            detail["webhook"] = notify_openloop(user_id, context)
        elif action == "pharmacy_trigger":
            detail["webhook"] = trigger_pharmacy(user_id, context)
        elif action == "clinician_alert":
            detail["queue"] = queue_clinician_alert(user_id, context)
        else:
            detail["warning"] = f"unknown_action:{action}"
            status = "skipped"

        log = ActionLog(
            user_id=user_id,
            event_id=event_id,
            rule_id=rule_id,
            action_type=action,
            status=status,
            detail=detail,
        )
        db.add(log)
        logs.append(log)

    db.flush()
    return logs
