from typing import Any

from sqlalchemy.orm import Session

from app.models import ActionLog
from core.integrations import openloop as openloop_adapter
from core.integrations import pharmacy as pharmacy_adapter
from core.integrations import sms as sms_adapter


def _log(
    db: Session,
    user_id: int,
    action_type: str,
    payload: dict[str, Any],
    event_id: int | None,
) -> ActionLog:
    row = ActionLog(
        user_id=user_id,
        action_type=action_type,
        payload=payload,
        triggered_by_event_id=event_id,
    )
    db.add(row)
    db.flush()
    return row


def execute_actions(
    db: Session,
    user_id: int,
    event_id: int | None,
    actions: list[str],
    context: dict[str, Any],
) -> list[ActionLog]:
    """Execute system outputs; persist each to actions_log."""
    logs: list[ActionLog] = []
    for raw in actions:
        name = raw.strip()
        if name == "send_ai_message":
            logs.append(
                _log(
                    db,
                    user_id,
                    name,
                    {"note": "deferred_to_coaching_layer", "context_keys": list(context)},
                    event_id,
                )
            )
        elif name == "send_sms":
            result = sms_adapter.send_sms(
                to=str(context.get("sms_to", "user:stub")),
                body=str(context.get("sms_body", "Care team check-in")),
                meta={"source_event_id": event_id},
            )
            logs.append(
                _log(db, user_id, name, {"stub_result": result}, event_id)
            )
        elif name == "openloop_notify":
            result = openloop_adapter.notify(
                {"user_id": context.get("external_user_id"), "reason": context.get("reason")}
            )
            logs.append(
                _log(db, user_id, name, {"stub_result": result}, event_id)
            )
        elif name == "pharmacy_trigger":
            result = pharmacy_adapter.trigger(
                {"medication": context.get("medication")}
            )
            logs.append(
                _log(db, user_id, name, {"stub_result": result}, event_id)
            )
        elif name in ("clinician_alert", "notify_clinician"):
            logs.append(
                _log(
                    db,
                    user_id,
                    "clinician_alert",
                    {"queue": "stub", "message": context.get("alert_message")},
                    event_id,
                )
            )
        elif name == "schedule_checkin":
            logs.append(
                _log(
                    db,
                    user_id,
                    name,
                    {"scheduled": "stub", "window": "48h"},
                    event_id,
                )
            )
        else:
            logs.append(
                _log(
                    db,
                    user_id,
                    f"unknown:{name}",
                    {"error": "unsupported_action"},
                    event_id,
                )
            )
    return logs
