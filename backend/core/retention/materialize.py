"""
Retention + longitudinal signals derived from append-only events.

Keeps deterministic summaries in user_state for API/UI and coaching context.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from datetime import date, datetime, timedelta, timezone
from typing import Any


def _utc_date(ts: datetime) -> date:
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.astimezone(timezone.utc).date()


def _pearson(xs: list[float], ys: list[float]) -> float | None:
    n = len(xs)
    if n != len(ys) or n < 3:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys, strict=True))
    denx = sum((x - mx) ** 2 for x in xs) ** 0.5
    deny = sum((y - my) ** 2 for y in ys) ** 0.5
    if denx == 0 or deny == 0:
        return None
    r = num / (denx * deny)
    return max(-1.0, min(1.0, r))


def _daily_last_values(
    biomarker_points: list[tuple[datetime, str, float]],
) -> dict[str, dict[date, float]]:
    """Per metric, last value recorded on each UTC calendar day."""
    per_metric: dict[str, dict[date, float]] = defaultdict(dict)
    # Sort ascending so later same-day points overwrite
    for ts, key, val in sorted(biomarker_points, key=lambda x: x[0]):
        d = _utc_date(ts)
        per_metric[key][d] = val
    return per_metric


def _aligned_pairs(
    a_by_day: dict[date, float], b_by_day: dict[date, float]
) -> tuple[list[float], list[float]]:
    common = sorted(set(a_by_day) & set(b_by_day))
    return [a_by_day[d] for d in common], [b_by_day[d] for d in common]


def _current_checkin_streak(checkin_dates: set[date], today: date) -> int:
    if today in checkin_dates:
        start = today
    elif (today - timedelta(days=1)) in checkin_dates:
        start = today - timedelta(days=1)
    else:
        return 0
    d = start
    n = 0
    while d in checkin_dates:
        n += 1
        d -= timedelta(days=1)
    return n


def _longest_streak(checkin_dates: Iterable[date]) -> int:
    dates = sorted(set(checkin_dates))
    if not dates:
        return 0
    best = 1
    cur = 1
    for i in range(1, len(dates)):
        if dates[i] == dates[i - 1] + timedelta(days=1):
            cur += 1
            best = max(best, cur)
        else:
            cur = 1
    return best


def compute_retention_block(
    events: list[Any],
    *,
    now: datetime,
    biomarker_series_limit: int = 24,
) -> dict[str, Any]:
    """
    events: ORM Event rows with .timestamp, .event_type, .payload (newest first
    as produced by the state engine query).
    """
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    today = _utc_date(now)

    checkin_dates: set[date] = set()
    biomarker_points: list[tuple[datetime, str, float]] = []
    last_reflection: dict[str, Any] | None = None
    points_ledger = {
        "daily_checkin": 10,
        "weekly_reflection": 50,
        "biomarker_recorded": 5,
        "cost_quote_noted": 3,
        "external_data_ingested": 2,
    }
    engagement_points = 0
    chat_days: set[date] = set()

    for ev in events:
        ts = ev.timestamp
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)

        et = ev.event_type
        payload = ev.payload if isinstance(ev.payload, dict) else {}

        if et == "daily_checkin_completed":
            checkin_dates.add(_utc_date(ts))
            engagement_points += points_ledger["daily_checkin"]
        elif et == "weekly_reflection_submitted":
            if last_reflection is None:
                last_reflection = {
                    "week_label": payload.get("week_label"),
                    "differences_noted": payload.get("differences_noted"),
                    "focus_area": payload.get("focus_area"),
                    "timestamp": ts.isoformat(),
                }
            engagement_points += points_ledger["weekly_reflection"]
        elif et == "biomarker_recorded":
            key = str(payload.get("metric_key") or "").strip() or "unknown"
            try:
                val = float(payload.get("value"))
            except (TypeError, ValueError):
                continue
            biomarker_points.append((ts, key, val))
            engagement_points += points_ledger["biomarker_recorded"]
        elif et == "cost_quote_noted":
            engagement_points += points_ledger["cost_quote_noted"]
        elif et == "external_data_ingested":
            batch = payload.get("points")
            if isinstance(batch, list):
                for pt in batch:
                    if not isinstance(pt, dict):
                        continue
                    mk = str(pt.get("metric_key") or "").strip()
                    if not mk:
                        continue
                    try:
                        v = float(pt.get("value"))
                    except (TypeError, ValueError):
                        continue
                    # Use event timestamp if point has no ts
                    p_ts = ts
                    raw_ts = pt.get("recorded_at")
                    if isinstance(raw_ts, str):
                        try:
                            p_ts = datetime.fromisoformat(raw_ts.replace("Z", "+00:00"))
                        except ValueError:
                            p_ts = ts
                    biomarker_points.append((p_ts, mk, v))
            engagement_points += points_ledger["external_data_ingested"]
        elif et == "chat_message_received":
            chat_days.add(_utc_date(ts))

    streak_current = _current_checkin_streak(checkin_dates, today)
    streak_best = _longest_streak(checkin_dates)
    submitted_today = today in checkin_dates

    # Per-metric time series (most recent first), capped
    series_map: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for ts, key, val in sorted(biomarker_points, key=lambda x: x[0], reverse=True):
        entry = {"t": ts.isoformat(), "value": val}
        if len(series_map[key]) < biomarker_series_limit:
            series_map[key].append(entry)

    daily_by_metric = _daily_last_values(biomarker_points)
    keys = sorted(daily_by_metric.keys())
    correlations: list[dict[str, Any]] = []
    for i, ka in enumerate(keys):
        for kb in keys[i + 1 :]:
            xa, ya = _aligned_pairs(daily_by_metric[ka], daily_by_metric[kb])
            r = _pearson(xa, ya)
            if r is not None:
                correlations.append(
                    {
                        "metric_a": ka,
                        "metric_b": kb,
                        "n_days": len(xa),
                        "pearson_r": round(r, 4),
                    }
                )

    correlations.sort(key=lambda c: abs(c["pearson_r"]), reverse=True)

    return {
        "check_in": {
            "streak_current_days": streak_current,
            "streak_best_days": streak_best,
            "submitted_today": submitted_today,
            "unique_checkin_days": len(checkin_dates),
        },
        "gamification": {
            "engagement_points": int(min(1_000_000, engagement_points)),
            "points_ledger": points_ledger,
        },
        "longitudinal": {
            "biomarker_series": {k: v for k, v in series_map.items()},
            "correlations_top": correlations[:6],
            "last_weekly_reflection": last_reflection,
        },
        "continuity": {
            "chat_active_days": len(chat_days),
        },
    }
