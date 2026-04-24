import pytest
from fastapi.testclient import TestClient

from backend.main import app


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def test_prescription_schedule_endpoint(client: TestClient):
    body = {
        "user_id": "sched_user",
        "schedule": {
            "version": 1,
            "source": "test",
            "medications": [
                {
                    "medication_id": "m1",
                    "display_name": "Drug A",
                    "timezone": "UTC",
                    "doses": [{"time_local": "09:00"}, {"time_local": "21:00", "days_of_week": [0, 2, 4]}],
                }
            ],
        },
    }
    r = client.post("/v1/events/prescription_schedule", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["event_id"]
    assert data["user_state"]["prescription_schedule"]["medications"][0]["medication_id"] == "m1"


def test_prescription_schedule_validation(client: TestClient):
    r = client.post(
        "/v1/events/prescription_schedule",
        json={"user_id": "u", "schedule": {"version": 1, "medications": []}},
    )
    assert r.status_code == 422
