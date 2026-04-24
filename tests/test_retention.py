from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from backend.main import app


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def test_daily_checkin_idempotent_same_day_and_points(client: TestClient):
    uid = "ret_user_streak"
    r = client.post(
        "/v1/events/daily_checkin",
        json={"user_id": uid, "mood_1_5": 4, "note": "first"},
    )
    assert r.status_code == 200
    assert r.json()["status"] == "recorded"

    r2 = client.post("/v1/events/daily_checkin", json={"user_id": uid, "mood_1_5": 3})
    assert r2.status_code == 200
    assert r2.json()["status"] == "already_completed_today"

    st = client.get(f"/v1/users/{uid}/state")
    assert st.status_code == 200
    ret = st.json()["retention"]
    assert ret["check_in"]["streak_current_days"] >= 1
    assert ret["check_in"]["submitted_today"] is True
    assert ret["gamification"]["engagement_points"] >= 10


def test_biomarkers_and_correlation_surface(client: TestClient):
    uid = "ret_user_bio"
    day0 = datetime.now(timezone.utc).replace(hour=10, minute=0, second=0, microsecond=0)
    for d in range(5):
        ts = (day0 - timedelta(days=4 - d)).isoformat()
        client.post(
            "/v1/events/biomarker",
            json={"user_id": uid, "metric_key": "bmi", "value": 28.0 + d * 0.1, "recorded_at": ts},
        )
        client.post(
            "/v1/events/biomarker",
            json={"user_id": uid, "metric_key": "weight_kg", "value": 90.0 - d * 0.2, "recorded_at": ts},
        )

    st = client.get(f"/v1/users/{uid}/state").json()
    series = st["retention"]["longitudinal"]["biomarker_series"]
    assert "bmi" in series and "weight_kg" in series
    corrs = st["retention"]["longitudinal"]["correlations_top"]
    assert any(c["metric_a"] == "bmi" and c["metric_b"] == "weight_kg" for c in corrs)


def test_weekly_reflection_then_chat_trace(client: TestClient):
    uid = "ret_user_refl"
    r = client.post(
        "/v1/events/weekly_reflection",
        json={
            "user_id": uid,
            "week_label": "Week 1",
            "differences_noted": "I walked after dinner instead of before work.",
            "focus_area": "movement",
        },
    )
    assert r.status_code == 200
    assert "coaching_preview" in r.json()

    chat = client.post("/v1/chat", json={"user_id": uid, "message": "How am I doing?"})
    assert chat.status_code == 200
    ctx = chat.json()["trace"]["ai_context"]["treatment_context"]
    assert ctx.get("last_weekly_reflection_summary", {}).get("differences_noted")


def test_external_series_ingestion(client: TestClient):
    uid = "ret_user_ext"
    r = client.post(
        "/v1/events/external_series",
        json={
            "user_id": uid,
            "platform": "payer_portal",
            "points": [
                {"metric_key": "copay_quote_usd", "value": 42.5, "recorded_at": "2026-04-01T15:00:00+00:00"},
                {"metric_key": "copay_quote_usd", "value": 39.0, "recorded_at": "2026-04-08T15:00:00+00:00"},
            ],
        },
    )
    assert r.status_code == 200
    assert r.json()["ingested_points"] == 2
