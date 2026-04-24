from sqlalchemy.orm import Session

from app.models import Rule


def seed_default_rules(db: Session) -> None:
    if db.query(Rule).count() > 0:
        return
    defaults = [
        {
            "name": "missed_meds_escalation",
            "rule_json": {
                "event_type": "medication_missed",
                "conditions": {"count_last_7_days": "> 2"},
                "actions": [
                    "send_ai_message",
                    "schedule_checkin",
                    "notify_clinician",
                ],
            },
        },
        {
            "name": "symptom_coaching",
            "rule_json": {
                "event_type": "symptom_reported",
                "conditions": {},
                "actions": ["send_ai_message"],
            },
        },
        {
            "name": "consult_onboarding",
            "rule_json": {
                "event_type": "consult_completed",
                "conditions": {},
                "actions": ["send_ai_message", "openloop_notify"],
            },
        },
    ]
    for row in defaults:
        db.add(Rule(name=row["name"], rule_json=row["rule_json"], enabled=True))
    db.commit()
