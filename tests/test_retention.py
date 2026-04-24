from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from backend.core.retention.profile import build_retention_profile, current_daily_checkin_streak


def test_streak_grace_yesterday():
    today = date(2026, 4, 24)
    days = {today - timedelta(days=1), today - timedelta(days=2)}
    assert current_daily_checkin_streak(days, today) == 2


def test_build_retention_profile_series_and_memory():
    base = datetime(2026, 4, 1, 12, 0, tzinfo=timezone.utc)
    events = [
        {
            "event_type": "metric_recorded",
            "timestamp": base,
            "payload": {"metric_id": "bmi", "value": 30.0, "unit": None},
        },
        {
            "event_type": "metric_recorded",
            "timestamp": base + timedelta(days=7),
            "payload": {"metric_id": "bmi", "value": 29.5},
        },
        {
            "event_type": "weekly_reflection_submitted",
            "timestamp": base + timedelta(days=7),
            "payload": {"week_number": 1, "what_changed": "Walked daily"},
        },
    ]
    newest_first = list(reversed(events))
    profile = build_retention_profile(newest_first, now=base + timedelta(days=8))
    assert "bmi" in profile["longitudinal"]["series"]
    assert profile["longitudinal"]["series"]["bmi"]["n"] == 2
    assert len(profile["longitudinal"]["weekly_reflection_memory"]) == 1
    assert profile["gamification"]["engagement_points"] == 2


def test_daily_checkin_and_state(client: TestClient):
    uid = "ret_test_user"
    r = client.post(
        "/v1/events/daily_checkin",
        json={"user_id": uid, "mood_1_5": 4, "energy_1_5": 3},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["user_state"]["retention"]["daily_checkin"]["streak_current"] >= 1

    s = client.get(f"/v1/users/{uid}/state")
    assert s.status_code == 200
    assert "retention" in s.json()


def test_metric_weekly_cost_flow(client: TestClient):
    uid = "ret_flow_user"
    assert client.post(
        "/v1/events/metric",
        json={"user_id": uid, "metric_id": "bmi", "value": 28.1},
    ).status_code == 200
    assert client.post(
        "/v1/events/weekly_reflection",
        json={"user_id": uid, "what_changed": "Meal prep Sundays"},
    ).status_code == 200
    assert client.post(
        "/v1/events/cost_barrier",
        json={"user_id": uid, "amount_today": 45.0, "reason": "copay"},
    ).status_code == 200

    last = client.post("/v1/events/cost_barrier", json={"user_id": uid, "amount_today": 12}).json()
    fired = {fr["name"] for fr in last["fired_rules"]}
    assert "Cost barrier noted → support + navigation" in fired
