from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from backend.models import Event, Rule


def _parse_condition(value: str, actual: int) -> bool:
    value = value.strip()
    if value.startswith("> "):
        return actual > int(value[2:].strip())
    if value.startswith(">="):
        return actual >= int(value[2:].strip())
    if value.startswith("< "):
        return actual < int(value[2:].strip())
    if value.startswith("="):
        return actual == int(value[1:].strip())
    return False


def _count_events(
    db: Session, user_id: str, event_type: str, since: datetime, until: datetime | None = None
) -> int:
    q = select(func.count()).select_from(Event).where(Event.user_id == user_id, Event.event_type == event_type)
    q = q.where(Event.timestamp >= since)
    if until is not None:
        q = q.where(Event.timestamp <= until)
    return int(db.scalar(q) or 0)


def evaluate_rules_for_event(
    db: Session, user_id: str, event_type: str, event_ts: datetime
) -> list[tuple[Rule, list[str]]]:
    """
    Return list of (rule, actions) for rules that matched this event.
    Rules are JSON: { "event_type", "conditions": { "count_last_7_days": "> 2" }, "actions": [...] }
    """
    rules = db.query(Rule).filter(Rule.enabled.is_(True)).all()
    matched: list[tuple[Rule, list[str]]] = []
    since_7d = event_ts - timedelta(days=7)

    for rule in rules:
        d = rule.definition or {}
        if d.get("event_type") != event_type:
            continue
        conditions = d.get("conditions") or {}
        ok = True
        for key, cond_val in conditions.items():
            if key == "count_last_7_days":
                # Scope count to the same event_type as the rule trigger
                count = _count_events(db, user_id, event_type, since_7d, event_ts)
                if isinstance(cond_val, str):
                    if not _parse_condition(cond_val, count):
                        ok = False
                else:
                    ok = False
            else:
                # MVP: unknown condition keys pass (extend later)
                pass
        if ok:
            actions = list(d.get("actions") or [])
            matched.append((rule, actions))
    return matched
