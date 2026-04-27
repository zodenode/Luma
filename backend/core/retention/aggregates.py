from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Iterable
from datetime import date, datetime, timedelta, timezone
from typing import Any


def _utc_dt(ts: datetime) -> datetime:
    if ts.tzinfo is None:
        return ts.replace(tzinfo=timezone.utc)
    return ts


def _event_day(ev: Any) -> date:
    ts = _utc_dt(ev.timestamp)
    return ts.date()


def _parse_day_from_payload(payload: dict[str, Any]) -> date | None:
    raw = payload.get("date_local") or payload.get("day")
    if not raw or not isinstance(raw, str):
        return None
    try:
        y, m, d = (int(x) for x in raw.split("-")[:3])
        return date(y, m, d)
    except (ValueError, TypeError):
        return None


def _engagement_days(events: Iterable[Any], since: date) -> set[date]:
    """Days with a deliberate retention touch (check-in, measurement, reflection)."""
    days: set[date] = set()
    types = {"daily_check_in", "series_measurement", "weekly_reflection"}
    for ev in events:
        if ev.event_type not in types:
            continue
        d = _event_day(ev)
        if d < since:
            continue
        if ev.event_type == "daily_check_in":
            p = ev.payload if isinstance(ev.payload, dict) else {}
            override = _parse_day_from_payload(p)
            days.add(override or d)
        else:
            days.add(d)
    return days


def compute_streak(engagement_days: set[date], today: date) -> tuple[int, int]:
    """Current consecutive-day streak ending today or yesterday; best streak in window."""
    if not engagement_days:
        return 0, 0

    def streak_ending_at(end: date) -> int:
        n = 0
        cur = end
        while cur in engagement_days:
            n += 1
            cur -= timedelta(days=1)
        return n

    cur_streak = streak_ending_at(today)
    if cur_streak == 0 and (today - timedelta(days=1)) in engagement_days:
        cur_streak = streak_ending_at(today - timedelta(days=1))

    sorted_days = sorted(engagement_days)
    best = 0
    run = 1
    for i in range(1, len(sorted_days)):
        if sorted_days[i] == sorted_days[i - 1] + timedelta(days=1):
            run += 1
            best = max(best, run)
        elif sorted_days[i] != sorted_days[i - 1]:
            run = 1
            best = max(best, run)
    best = max(best, run, cur_streak)
    return cur_streak, best


def _gamification_points(events: list[Any]) -> dict[str, Any]:
    total = 0
    by_type: dict[str, int] = defaultdict(int)
    for ev in events:
        pts = 0
        if ev.event_type == "daily_check_in":
            pts = 10
        elif ev.event_type == "series_measurement":
            pts = 5
        elif ev.event_type == "weekly_reflection":
            pts = 25
        elif ev.event_type == "chat_message_received":
            pts = 1
        if pts:
            total += pts
            by_type[ev.event_type] += pts
    level = min(50, 1 + total // 100)
    return {
        "total_points": total,
        "points_by_event_type": dict(by_type),
        "level": level,
        "next_level_at": level * 100 if level < 50 else None,
    }


def _series_from_events(events: list[Any], since: datetime) -> dict[str, list[dict[str, Any]]]:
    """series_id -> sorted list of {t, value, unit, source, day}."""
    series: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for ev in events:
        if ev.event_type != "series_measurement":
            continue
        ts = _utc_dt(ev.timestamp)
        if ts < since:
            continue
        p = ev.payload if isinstance(ev.payload, dict) else {}
        sid = str(p.get("series_id") or p.get("metric") or "unknown")
        try:
            val = float(p.get("value"))
        except (TypeError, ValueError):
            continue
        series[sid].append(
            {
                "t": ts.isoformat(),
                "day": ts.date().isoformat(),
                "value": val,
                "unit": str(p.get("unit") or ""),
                "source": str(p.get("source") or "patient_entered"),
                "label": p.get("label"),
            }
        )
    for sid in series:
        series[sid].sort(key=lambda x: x["t"])
    return dict(series)


def _daily_values_by_series(series: dict[str, list[dict[str, Any]]]) -> dict[str, dict[str, float]]:
    """For each series, last value per calendar day (UTC)."""
    out: dict[str, dict[str, float]] = {}
    for sid, pts in series.items():
        by_day: dict[str, float] = {}
        for pt in pts:
            d = pt["day"]
            by_day[d] = float(pt["value"])
        out[sid] = by_day
    return out


def pearson(xs: list[float], ys: list[float]) -> float | None:
    n = len(xs)
    if n < 3 or n != len(ys):
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((xs[i] - mx) * (ys[i] - my) for i in range(n))
    denx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    deny = math.sqrt(sum((y - my) ** 2 for y in ys))
    if denx == 0 or deny == 0:
        return None
    return round(num / (denx * deny), 4)


def _correlations_between_series(
    daily_by_series: dict[str, dict[str, float]],
    min_overlap: int = 3,
) -> list[dict[str, Any]]:
    ids = sorted(daily_by_series.keys())
    pairs: list[dict[str, Any]] = []
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            a, b = ids[i], ids[j]
            common_days = sorted(set(daily_by_series[a]) & set(daily_by_series[b]))
            if len(common_days) < min_overlap:
                continue
            xs = [daily_by_series[a][d] for d in common_days]
            ys = [daily_by_series[b][d] for d in common_days]
            r = pearson(xs, ys)
            if r is None:
                continue
            pairs.append(
                {
                    "series_a": a,
                    "series_b": b,
                    "pearson_r": r,
                    "overlapping_days": len(common_days),
                    "sample_days": common_days[-min(12, len(common_days)) :],
                }
            )
    pairs.sort(key=lambda x: abs(x["pearson_r"]), reverse=True)
    return pairs[:20]


def _reflections_tail(events: list[Any], limit: int = 12) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for ev in events:
        if ev.event_type != "weekly_reflection":
            continue
        p = ev.payload if isinstance(ev.payload, dict) else {}
        ts = _utc_dt(ev.timestamp)
        out.append(
            {
                "t": ts.isoformat(),
                "week_index": p.get("week_index"),
                "theme": p.get("theme"),
                "text": (p.get("text") or p.get("reflection") or "")[:2000],
                "tags": p.get("tags") if isinstance(p.get("tags"), list) else [],
            }
        )
    out.sort(key=lambda x: x["t"], reverse=True)
    return out[:limit]


def build_retention_snapshot(events: list[Any], now: datetime | None = None) -> dict[str, Any]:
    """
    Deterministic retention layer from append-only events (no extra tables).
    """
    now = now or datetime.now(timezone.utc)
    now = _utc_dt(now)
    today = now.date()
    since_90d = now - timedelta(days=90)
    since_365d = now - timedelta(days=365)
    day_floor = (now - timedelta(days=365)).date()

    recent_for_retention = [e for e in events if _utc_dt(e.timestamp) >= since_365d]

    engagement_days = _engagement_days(recent_for_retention, day_floor)
    streak_current, streak_best = compute_streak(engagement_days, today)

    series = _series_from_events(recent_for_retention, since_90d)
    daily_vals = _daily_values_by_series(series)
    correlations = _correlations_between_series(daily_vals)

    check_ins_30d = sum(
        1
        for e in recent_for_retention
        if e.event_type == "daily_check_in" and _utc_dt(e.timestamp) >= now - timedelta(days=30)
    )
    measurements_30d = sum(
        1
        for e in recent_for_retention
        if e.event_type == "series_measurement" and _utc_dt(e.timestamp) >= now - timedelta(days=30)
    )

    gamification = _gamification_points(recent_for_retention)

    series_summary: dict[str, Any] = {}
    for sid, pts in series.items():
        vals = [float(p["value"]) for p in pts]
        if not vals:
            continue
        first, last = vals[0], vals[-1]
        delta = last - first
        series_summary[sid] = {
            "n": len(vals),
            "first": first,
            "last": last,
            "delta": round(delta, 4),
            "unit": pts[-1].get("unit", ""),
            "latest_source": pts[-1].get("source"),
        }

    return {
        "streak": {
            "current_days": streak_current,
            "best_days": streak_best,
            "active_engagement_days_365d": len(engagement_days),
        },
        "gamification": gamification,
        "activity_30d": {
            "daily_check_ins": check_ins_30d,
            "series_measurements": measurements_30d,
        },
        "series": {k: v[-60:] for k, v in series.items()},
        "series_summary": series_summary,
        "correlations": correlations,
        "weekly_reflections_recent": _reflections_tail(recent_for_retention, 12),
    }
