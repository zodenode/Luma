"""Retention-oriented rollups from append-only events (streaks, series, reflections)."""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any

from backend.core.models import Event


def _utc_date(dt: datetime) -> date:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).date()


def _parse_observed_at(payload: dict[str, Any], fallback: datetime) -> datetime:
    raw = payload.get("observed_at") or payload.get("recorded_at")
    if isinstance(raw, str):
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed
        except (ValueError, TypeError):
            pass
    return fallback


def compute_checkin_streak(checkin_dates: set[date], today: date) -> int:
    """
    Consecutive calendar days (UTC) ending at the most recent check-in.
    Streak stays 'alive' if the last check-in was today or yesterday.
    """
    if not checkin_dates:
        return 0
    last = max(checkin_dates)
    if last < today - timedelta(days=1):
        return 0
    anchor = last
    streak = 0
    d = anchor
    while d in checkin_dates:
        streak += 1
        d -= timedelta(days=1)
    return streak


def retention_xp(total_checkins: int, streak: int) -> int:
    return total_checkins * 10 + max(0, streak) * 3


def retention_level(xp: int) -> int:
    return min(99, max(1, int(xp // 75) + 1))


def aggregate_clinical_series(
    events: list[Event],
    per_series_limit: int = 60,
) -> dict[str, Any]:
    """Build per-series points and simple trend from clinical_metric_recorded events."""
    by_series: dict[str, list[tuple[datetime, float, dict[str, Any]]]] = defaultdict(list)

    for ev in events:
        if ev.event_type != "clinical_metric_recorded":
            continue
        p = ev.payload if isinstance(ev.payload, dict) else {}
        key = str(p.get("series_key") or "").strip()
        if not key:
            continue
        try:
            val = float(p.get("value"))
        except (TypeError, ValueError):
            continue
        ts = _parse_observed_at(p, ev.timestamp)
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        by_series[key].append((ts, val, dict(p)))

    rollups: dict[str, Any] = {}
    for key, pts in by_series.items():
        pts.sort(key=lambda x: x[0])
        tail = pts[-per_series_limit:]
        values = [v for _, v, _ in tail]
        times = [t.isoformat() for t, _, _ in tail]
        last = values[-1] if values else None
        prev = values[-2] if len(values) >= 2 else None
        trend = "flat"
        if last is not None and prev is not None:
            if last > prev * 1.01:
                trend = "up"
            elif last < prev * 0.99:
                trend = "down"
        rollups[key] = {
            "last_value": last,
            "previous_value": prev,
            "trend": trend,
            "n_points": len(values),
            "first_observed_at": times[0] if times else None,
            "last_observed_at": times[-1] if times else None,
            "recent_values": values[-12:],
            "recent_timestamps": times[-12:],
        }
    return rollups


def correlation_hints(rollups: dict[str, Any]) -> list[str]:
    """Lightweight copy for coach context — not statistical inference."""
    hints: list[str] = []
    if "bmi" in rollups and "weight_kg" in rollups:
        b = rollups["bmi"]
        w = rollups["weight_kg"]
        if b.get("trend") == w.get("trend") and b.get("trend") != "flat":
            hints.append(
                f"BMI and weight are both trending **{b['trend']}** over logged readings "
                f"(BMI n={b.get('n_points')}, weight n={w.get('n_points')})."
            )
    for key, r in rollups.items():
        if r.get("n_points", 0) >= 3 and r.get("trend") != "flat":
            hints.append(
                f"**{key}** moved **{r['trend']}** from earlier values to **{r.get('last_value')}** "
                f"across {r.get('n_points')} logged points."
            )
    return hints[:6]


def latest_weekly_reflections(events: list[Event], limit: int = 5) -> list[dict[str, Any]]:
    """Events are expected newest-first; returned list is newest reflections first."""
    out: list[dict[str, Any]] = []
    for ev in events:
        if ev.event_type != "weekly_reflection_recorded":
            continue
        p = ev.payload if isinstance(ev.payload, dict) else {}
        ts = ev.timestamp
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        out.append(
            {
                "timestamp": ts.isoformat(),
                "week_label": p.get("week_label"),
                "what_changed": p.get("what_changed"),
                "wins": p.get("wins"),
                "struggles": p.get("struggles"),
                "notes": p.get("notes"),
            }
        )
    return out[:limit]
