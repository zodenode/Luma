"""
Longitudinal retention profile: streaks, series, weekly memory, simple trends.

Pure functions over normalized event rows for testability and state materialisation.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any


def _ensure_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _day_key(dt: datetime) -> date:
    return _ensure_utc(dt).date()


def _parse_ts(ts: datetime | str) -> datetime:
    if isinstance(ts, datetime):
        return _ensure_utc(ts)
    # ISO string from JSON replay
    raw = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    return _ensure_utc(raw)


def _longest_consecutive_day_streak(event_days: set[date]) -> int:
    if not event_days:
        return 0
    sorted_days = sorted(event_days)
    best = 1
    run = 1
    for i in range(1, len(sorted_days)):
        if sorted_days[i] == sorted_days[i - 1] + timedelta(days=1):
            run += 1
            best = max(best, run)
        else:
            run = 1
    return best


def current_daily_checkin_streak(
    event_days: set[date],
    today: date,
) -> int:
    """
    Consecutive days with a daily check-in, anchored to today or yesterday if today is empty
    (common grace pattern for daily retention).
    """
    if today in event_days:
        cursor = today
    elif (today - timedelta(days=1)) in event_days:
        cursor = today - timedelta(days=1)
    else:
        return 0
    streak = 0
    while cursor in event_days:
        streak += 1
        cursor -= timedelta(days=1)
    return streak


def _collect_daily_checkin_days(events_newest_first: list[dict[str, Any]]) -> set[date]:
    days: set[date] = set()
    for e in events_newest_first:
        if e.get("event_type") != "daily_checkin_completed":
            continue
        days.add(_day_key(_parse_ts(e["timestamp"])))
    return days


def _week_index(program_start: date | None, d: date) -> int | None:
    if program_start is None:
        return None
    delta = (d - program_start).days
    if delta < 0:
        return None
    return delta // 7 + 1


def _infer_program_start(events_oldest_first: list[dict[str, Any]]) -> date | None:
    retention_types = {
        "daily_checkin_completed",
        "weekly_reflection_submitted",
        "metric_recorded",
        "cost_barrier_noted",
        "lab_result_received",
    }
    for e in events_oldest_first:
        if e.get("event_type") in retention_types:
            return _day_key(_parse_ts(e["timestamp"]))
    return None


def _metric_series(events_oldest_first: list[dict[str, Any]], limit_per_series: int = 24) -> dict[str, Any]:
    buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for e in events_oldest_first:
        if e.get("event_type") != "metric_recorded":
            continue
        p = e.get("payload") or {}
        if not isinstance(p, dict):
            continue
        mid = str(p.get("metric_id") or "").strip()
        if not mid:
            continue
        ts = _parse_ts(e["timestamp"])
        buckets[mid].append(
            {
                "t": ts.isoformat(),
                "value": p.get("value"),
                "unit": p.get("unit"),
                "source": p.get("source"),
                "note": p.get("note"),
            }
        )
    out: dict[str, Any] = {}
    for mid, pts in buckets.items():
        pts.sort(key=lambda x: x["t"])
        tail = pts[-limit_per_series:]
        out[mid] = {"points": tail, "n": len(tail)}
    return out


def _simple_trend(points: list[dict[str, Any]]) -> str | None:
    vals: list[float] = []
    for p in points:
        v = p.get("value")
        try:
            if v is None:
                continue
            vals.append(float(v))
        except (TypeError, ValueError):
            continue
    if len(vals) < 2:
        return None
    a, b = vals[-2], vals[-1]
    if b > a * 1.01:
        return "up"
    if b < a * 0.99:
        return "down"
    return "flat"


def _weekly_reflections_memory(events_oldest_first: list[dict[str, Any]], max_n: int = 8) -> list[dict[str, Any]]:
    mem: list[dict[str, Any]] = []
    for e in events_oldest_first:
        if e.get("event_type") != "weekly_reflection_submitted":
            continue
        p = e.get("payload") or {}
        if not isinstance(p, dict):
            continue
        mem.append(
            {
                "week_number": p.get("week_number"),
                "timestamp": _parse_ts(e["timestamp"]).isoformat(),
                "what_changed": (p.get("what_changed") or p.get("narrative") or "")[:500],
                "challenges": (p.get("challenges") or "")[:300],
            }
        )
    return mem[-max_n:]


def _correlations_stub(series: dict[str, Any]) -> list[dict[str, Any]]:
    """Lightweight cross-series hints for coaching continuity (no clinical inference)."""
    hints: list[dict[str, Any]] = []
    bmi = series.get("bmi", {}).get("points") or []
    w = series.get("weight_kg", {}).get("points") or []
    if len(bmi) >= 2:
        hints.append(
            {
                "pair": ("bmi",),
                "trend": _simple_trend(bmi),
                "label": "BMI trajectory (user-reported)",
            }
        )
    if len(w) >= 2:
        hints.append(
            {
                "pair": ("weight_kg",),
                "trend": _simple_trend(w),
                "label": "Weight trajectory (user-reported)",
            }
        )
    if len(bmi) >= 2 and len(w) >= 2:
        hints.append(
            {
                "pair": ("bmi", "weight_kg"),
                "note": "Both series present; week-over-week coaching can link behaviours to logged values.",
            }
        )
    return hints


def build_retention_profile(
    events_newest_first: list[dict[str, Any]],
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    """
    events_newest_first: each item has keys event_type, timestamp (datetime or ISO), payload (dict).
    """
    now = _ensure_utc(now or datetime.now(timezone.utc))
    today = now.date()

    chronological = list(reversed(events_newest_first))
    program_start = _infer_program_start(chronological)
    week_number = _week_index(program_start, today)

    days = _collect_daily_checkin_days(events_newest_first)
    streak = current_daily_checkin_streak(days, today)
    longest = _longest_consecutive_day_streak(days)

    series = _metric_series(chronological)
    weekly_memory = _weekly_reflections_memory(chronological)

    points_total = sum(int(s.get("n") or 0) for s in series.values() if isinstance(s, dict))
    level = 1 + min(50, points_total // 5)

    return {
        "program": {
            "start_date": program_start.isoformat() if program_start else None,
            "week_number_estimated": week_number,
        },
        "daily_checkin": {
            "streak_current": streak,
            "streak_longest": longest,
            "last_30d_checkin_days": len([d for d in days if d >= today - timedelta(days=30)]),
        },
        "gamification": {
            "engagement_points": points_total,
            "level": level,
            "badges": _badges_for(streak, points_total, len(weekly_memory)),
        },
        "longitudinal": {
            "series": series,
            "correlation_hints": _correlations_stub(series),
            "weekly_reflection_memory": weekly_memory,
        },
    }


def _badges_for(streak: int, points: int, weeks_logged: int) -> list[str]:
    badges: list[str] = []
    if streak >= 3:
        badges.append("streak_3")
    if streak >= 7:
        badges.append("streak_7")
    if points >= 5:
        badges.append("tracker_5")
    if weeks_logged >= 1:
        badges.append("weekly_reflector")
    if weeks_logged >= 4:
        badges.append("monthly_storyteller")
    return badges
