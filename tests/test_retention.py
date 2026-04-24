from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from backend.main import app


def test_daily_checkin_builds_streak_and_xp(client: TestClient):
    uid = "ret_u1"
    base = datetime.now(timezone.utc).replace(hour=12, minute=0, second=0, microsecond=0)
    for i in range(5):
        fixed = base - timedelta(days=4 - i)
        r = client.post(
            "/v1/events/daily_checkin",
            json={"user_id": uid, "mood": 7, "recorded_at": fixed.isoformat()},
        )
        assert r.status_code == 200
    st = client.get(f"/v1/users/{uid}/state")
    assert st.status_code == 200
    body = st.json()
    ret = body.get("retention") or {}
    assert ret.get("checkin_streak_days") == 5
    assert ret.get("retention_xp", 0) > 0


def test_clinical_metric_rollup_and_correlation_hint(client: TestClient):
    uid = "ret_u2"
    client.post(
        "/v1/events/clinical_metric",
        json={"user_id": uid, "series_key": "bmi", "value": 30.0},
    )
    client.post(
        "/v1/events/clinical_metric",
        json={"user_id": uid, "series_key": "bmi", "value": 29.5},
    )
    client.post(
        "/v1/events/clinical_metric",
        json={"user_id": uid, "series_key": "weight_kg", "value": 92.0},
    )
    client.post(
        "/v1/events/clinical_metric",
        json={"user_id": uid, "series_key": "weight_kg", "value": 91.0},
    )
    st = client.get(f"/v1/users/{uid}/state")
    assert st.status_code == 200
    snap = st.json()
    series = snap.get("clinical_series") or {}
    assert "bmi" in series and "weight_kg" in series
    hints = snap.get("correlation_hints") or []
    assert any("BMI" in h and "weight" in h for h in hints)


def test_weekly_reflection_surfaces_in_state_and_coaching(client: TestClient):
    uid = "ret_u3"
    r = client.post(
        "/v1/events/weekly_reflection",
        json={
            "user_id": uid,
            "week_label": "W1",
            "what_changed": "Started walking after dinner.",
            "wins": "Three walks",
            "struggles": "Cravings",
        },
    )
    assert r.status_code == 200
    assert "coaching_preview" in r.json()
    st = client.get(f"/v1/users/{uid}/state")
    refs = st.json().get("weekly_reflections") or []
    assert refs and refs[0].get("what_changed")


def test_external_cost_sync_in_timeline(client: TestClient):
    uid = "ret_u4"
    client.post(
        "/v1/events/external_sync",
        json={
            "user_id": uid,
            "resource_type": "cost_estimate",
            "platform": "payer_portal",
            "payload": {"amount_usd": 55.0, "label": "today"},
        },
    )
    st = client.get(f"/v1/users/{uid}/state")
    costs = st.json().get("cost_timeline") or []
    assert costs and costs[-1].get("amount") == 55.0


def test_dashboard_endpoint(client: TestClient):
    uid = "ret_u5"
    client.post("/v1/events/clinical_metric", json={"user_id": uid, "series_key": "a1c", "value": 6.2})
    d = client.get(f"/v1/users/{uid}/dashboard")
    assert d.status_code == 200
    data = d.json()
    assert "snapshot" in data and "clinical_metric_timeline" in data


def test_retention_ui_ok(client: TestClient):
    r = client.get("/retention")
    assert r.status_code == 200
    assert "Retention dashboard" in r.text
