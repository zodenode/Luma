from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from backend.core.db.models import Event, Rule, UserState


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _parse_threshold(expr: str) -> tuple[str, float]:
    """Parse strings like '> 2', '>= 2.5', '== 3'."""
    m = re.match(r"^\s*(>=|<=|==|!=|>|<)\s*([0-9.]+)\s*$", expr.strip())
    if not m:
        raise ValueError(f"Unsupported threshold expression: {expr!r}")
    return m.group(1), float(m.group(2))


def _compare(op: str, left: float, right: float) -> bool:
    if op == ">":
        return left > right
    if op == "<":
        return left < right
    if op == ">=":
        return left >= right
    if op == "<=":
        return left <= right
    if op == "==":
        return left == right
    if op == "!=":
        return left != right
    return False


def _count_events_since(
    session: Session,
    user_id: str,
    event_type: str,
    since: datetime,
) -> int:
    q = (
        select(func.count())
        .select_from(Event)
        .where(
            Event.user_id == user_id,
            Event.event_type == event_type,
            Event.timestamp >= since,
        )
    )
    return int(session.scalar(q) or 0)


def _conditions_met(
    session: Session,
    user_id: str,
    trigger_event_type: str,
    conditions: dict,
    state: UserState,
) -> bool:
    if not conditions:
        return True

    now = _utcnow()
    since_7d = now - timedelta(days=7)

    for key, raw in conditions.items():
        if key == "count_last_7_days":
            et = conditions.get("event_type_for_count", trigger_event_type)
            count = _count_events_since(session, user_id, et, since_7d)
            if isinstance(raw, (int, float)):
                if count != int(raw):
                    return False
            elif isinstance(raw, str):
                op, thr = _parse_threshold(raw)
                if not _compare(op, float(count), thr):
                    return False
            else:
                return False

        elif key == "event_type_for_count":
            continue

        elif key == "risk_level":
            if state.risk_level != str(raw):
                return False

        elif key == "adherence_below":
            if not (state.adherence_score < float(raw)):
                return False

        elif key == "active_treatment_status":
            if state.active_treatment_status != str(raw):
                return False

        else:
            # Unknown condition keys fail closed for safety in v1
            return False

    return True


def evaluate_rules_for_event(
    session: Session,
    user_id: str,
    event_type: str,
    state: UserState,
) -> list[tuple[Rule, list[str]]]:
    """Return list of (rule, actions) for rules that fire."""
    q = select(Rule).where(Rule.enabled.is_(True))
    fired: list[tuple[Rule, list[str]]] = []
    for rule in session.scalars(q):
        definition = rule.definition or {}
        if definition.get("event_type") != event_type:
            continue
        conditions = definition.get("conditions") or {}
        if not _conditions_met(session, user_id, event_type, conditions, state):
            continue
        actions = list(definition.get("actions") or [])
        fired.append((rule, actions))
    return fired
