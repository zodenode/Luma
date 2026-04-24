from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Event, Rule


@dataclass
class RuleMatch:
    rule_id: int
    rule_name: str
    actions: list[str]
    rule_json: dict[str, Any]


def _parse_cmp(expr: str) -> tuple[str, int] | None:
    """
    Parse comparisons like '> 2', '>= 3', '== 1'.
    Leading operator form is required for count_last_7_days rules.
    """
    expr = expr.strip()
    for op in (">=", "<=", "==", ">", "<"):
        if expr.startswith(op):
            rest = expr[len(op) :].strip()
            if not rest:
                return None
            try:
                return op, int(rest)
            except ValueError:
                return None
    return None


def _count_last_days(
    db: Session, user_id: int, event_type: str, days: int, as_of: datetime
) -> int:
    since = as_of - timedelta(days=days)
    q = select(func.count()).select_from(Event).where(
        Event.user_id == user_id,
        Event.event_type == event_type,
        Event.timestamp >= since,
        Event.timestamp <= as_of,
    )
    return int(db.execute(q).scalar_one())


def _condition_met(
    db: Session,
    user_id: int,
    event: Event,
    conditions: dict[str, Any],
) -> bool:
    if not conditions:
        return True
    for key, val in conditions.items():
        if key == "count_last_7_days":
            cmp = _parse_cmp(str(val))
            if not cmp:
                return False
            op, threshold = cmp
            count = _count_last_days(db, user_id, event.event_type, 7, event.timestamp)
            if op == ">" and not (count > threshold):
                return False
            if op == ">=" and not (count >= threshold):
                return False
            if op == "<" and not (count < threshold):
                return False
            if op == "<=" and not (count <= threshold):
                return False
            if op == "==" and not (count == threshold):
                return False
        elif key == "risk_level_equals":
            continue
    return True


def evaluate_rules_for_event(
    db: Session, user_id: int, event: Event
) -> list[RuleMatch]:
    """Evaluate enabled JSON rules for the given event."""
    rules = (
        db.query(Rule).filter(Rule.enabled.is_(True)).order_by(Rule.id).all()
    )
    matches: list[RuleMatch] = []
    for r in rules:
        spec = r.rule_json or {}
        if spec.get("event_type") != event.event_type:
            continue
        cond = spec.get("conditions") or {}
        if not _condition_met(db, user_id, event, cond):
            continue
        actions = spec.get("actions") or []
        if isinstance(actions, list):
            matches.append(
                RuleMatch(
                    rule_id=r.id,
                    rule_name=r.name,
                    actions=[str(a) for a in actions],
                    rule_json=spec,
                )
            )
    return matches
