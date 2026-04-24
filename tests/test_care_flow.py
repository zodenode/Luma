import os
import tempfile

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import backend.database as db_mod
from backend.database import Base, get_db
from backend.main import app


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch):
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    test_engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    monkeypatch.setattr(db_mod, "engine", test_engine)
    db_mod.SessionLocal.configure(bind=test_engine)

    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)

    def override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()
    os.unlink(path)


def test_symptom_event_and_chat_pipeline(client: TestClient):
    uid = "user-1"
    r = client.post(
        "/v1/events",
        json={"event_type": "symptom_reported", "user_id": uid, "payload": {"symptom": "headache"}},
    )
    assert r.status_code == 200
    st = client.get(f"/v1/users/{uid}/state")
    assert st.status_code == 200
    assert st.json()["risk_level"] == "elevated"

    chat = client.post("/v1/chat", json={"user_id": uid, "message": "What should I do?"})
    assert chat.status_code == 200
    body = chat.json()
    assert "reply" in body
    assert body["trace"]["event_id"]


def test_medication_escalation(client: TestClient):
    uid = "user-2"
    for _ in range(4):
        rr = client.post("/v1/events", json={"event_type": "medication_missed", "user_id": uid, "payload": {}})
        assert rr.status_code == 200
    actions = client.get(f"/v1/users/{uid}/actions")
    assert actions.status_code == 200
    types = {a["action_type"] for a in actions.json()}
    assert "notify_clinician" in types or "schedule_checkin" in types
