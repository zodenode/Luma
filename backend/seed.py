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
        "name": "Daily check-in streak → reinforcement",
        "definition": {
            "event_type": "daily_checkin_completed",
            "count_event_type": "daily_checkin_completed",
            "conditions": {"count_last_7_days": ">= 5"},
            "actions": ["send_ai_message"],
        },
    },
    {
        "name": "Weekly reflection → coaching touchpoint",
        "definition": {
            "event_type": "weekly_reflection_recorded",
            "conditions": {},
            "actions": ["send_ai_message"],
        },
    },
]


def seed_rules(db: Session) -> int:
    existing = db.scalar(select(Rule).limit(1))
    if existing:
        return 0
    for r in DEFAULT_RULES:
        db.add(Rule(name=r["name"], definition=r["definition"], enabled=True))
    db.commit()
    return len(DEFAULT_RULES)


def bootstrap() -> None:
    init_db()
    db = SessionLocal()
    try:
        seed_rules(db)
    finally:
        db.close()
