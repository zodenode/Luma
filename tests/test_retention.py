import pytest
from fastapi.testclient import TestClient

from backend.main import app


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def test_daily_check_in_and_state_retention(client: TestClient):
    uid = "ret_user_1"
    r = client.post(
        "/v1/events/daily_check_in",
        json={"user_id": uid, "mood": 4, "note": "On track"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["event_id"]
    assert "retention" in body["user_state"]

    st = client.get(f"/v1/users/{uid}/state")
    assert st.status_code == 200
    data = st.json()
    assert data["retention"]["streak"]["current_days"] >= 1
    assert "retention_timeline" in data
    assert any(e["event_type"] == "daily_check_in" for e in data["retention_timeline"])


def test_series_and_correlation_in_state(client: TestClient):
    uid = "ret_user_2"
    for i, (sid, v) in enumerate([("weight_kg", 90.0), ("bmi", 28.0), ("weight_kg", 89.5), ("bmi", 27.8)]):
        rr = client.post(
            "/v1/events/series_measurement",
            json={"user_id": uid, "series_id": sid, "value": v + i * 0.01, "unit": "si" if sid == "bmi" else "kg"},
        )
        assert rr.status_code == 200

    st = client.get(f"/v1/users/{uid}/state")
    assert st.status_code == 200
    data = st.json()
    assert "weight_kg" in (data["retention"].get("series") or {})
    assert isinstance(data["retention"].get("correlations"), list)


def test_weekly_reflection_coaching_preview(client: TestClient):
    uid = "ret_user_3"
    r = client.post(
        "/v1/events/weekly_reflection",
        json={"user_id": uid, "week_index": 1, "text": "Switched to morning walks."},
    )
    assert r.status_code == 200
    assert r.json().get("coaching_preview")
    st = client.get(f"/v1/users/{uid}/state")
    refs = st.json()["retention"].get("weekly_reflections_recent") or []
    assert refs and "walks" in refs[0]["text"].lower()
