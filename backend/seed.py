from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.core.database import SessionLocal, init_db
from backend.core.models import Rule


DEFAULT_RULES: list[dict] = [
    {
        "name": "Escalate repeated missed doses",
        "definition": {
            "event_type": "medication_missed",
            "count_event_type": "medication_missed",
            "conditions": {"count_last_7_days": "> 2"},
            "actions": ["send_ai_message", "schedule_checkin", "notify_clinician"],
        },
    },
    {
        "name": "Symptom → coaching touchpoint",
        "definition": {
            "event_type": "symptom_reported",
            "conditions": {},
            "actions": ["send_ai_message"],
        },
    },
    {
        "name": "Consult completed → onboarding nudge",
        "definition": {
            "event_type": "consult_completed",
            "conditions": {},
            "actions": ["send_ai_message", "openloop_notify"],
        },
    },
    {
        "name": "Daily check-in → retention nudge",
        "definition": {
            "event_type": "daily_check_in",
            "conditions": {},
            "actions": ["send_ai_message"],
        },
    },
    {
        "name": "Weekly reflection → deepen engagement",
        "definition": {
            "event_type": "weekly_reflection",
            "conditions": {},
            "actions": ["send_ai_message", "schedule_checkin"],
        },
    },
]


def seed_rules(db: Session) -> int:
    existing_names = {row.name for row in db.scalars(select(Rule)).all()}
    added = 0
    for r in DEFAULT_RULES:
        if r["name"] in existing_names:
            continue
        db.add(Rule(name=r["name"], definition=r["definition"], enabled=True))
        added += 1
    if added:
        db.commit()
    return added


def bootstrap() -> None:
    init_db()
    db = SessionLocal()
    try:
        seed_rules(db)
    finally:
        db.close()
