import re
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from backend.core.models import Event, Rule


def _parse_threshold(expr: str) -> tuple[str, float] | None:
    """Parse simple comparisons like '> 2', '>= 3', '< 1'."""
    m = re.match(r"^\s*([><=!]+)\s*([0-9.]+)\s*$", expr)
    if not m:
        return None
    op, num = m.group(1), float(m.group(2))
    return op, num


def _compare(op: str, left: float, right: float) -> bool:
    if op == ">":
        return left > right
    if op == ">=":
        return left >= right
    if op == "<":
        return left < right
    if op == "<=":
        return left <= right
    if op in ("==", "="):
        return left == right
    return False


def _count_events(
    db: Session,
    user_id: str,
    event_type: str,
    since: datetime,
) -> int:
    q = select(func.count()).select_from(Event).where(
        Event.user_id == user_id,
        Event.event_type == event_type,
        Event.timestamp >= since,
    )
    return int(db.scalar(q) or 0)


def evaluate_rules_for_event(
    db: Session,
    user_id: str,
    event_type: str,
    event_id: str,
) -> list[dict[str, Any]]:
    """
    Return list of fired rules: {rule_id, name, actions, definition}.
    MVP: JSON rules with event_type match + simple count_last_7_days conditions.
    """
    now = datetime.now(timezone.utc)
    since_7d = now - timedelta(days=7)

    rules = db.scalars(select(Rule).where(Rule.enabled.is_(True))).all()
    fired: list[dict[str, Any]] = []

    for rule in rules:
        definition = rule.definition or {}
        if definition.get("event_type") not in (event_type, "*"):
            continue

        conditions = definition.get("conditions") or {}
        ok = True
        for key, expr in conditions.items():
            if key == "count_last_7_days":
                target_type = definition.get("count_event_type") or event_type
                count = _count_events(db, user_id, target_type, since_7d)
                parsed = _parse_threshold(str(expr))
                if parsed is None:
                    ok = False
                    break
                op, threshold = parsed
                if not _compare(op, float(count), threshold):
                    ok = False
                    break
            else:
                # Unknown condition keys are ignored in v1
                continue

        if ok:
            fired.append(
                {
                    "rule_id": rule.id,
                    "name": rule.name,
                    "actions": list(definition.get("actions") or []),
                    "definition": definition,
                    "triggered_by_event_id": event_id,
                }
            )

    return fired
