import uuid
from datetime import datetime, timedelta

from fastapi.testclient import TestClient
from app.database import SessionLocal, init_db
from app.main import app
from app.models import Event, User
from app.seed import seed_default_rules


def setup_module():
    init_db()
    db = SessionLocal()
    try:
        seed_default_rules(db)
    finally:
        db.close()


client = TestClient(app)


def test_chat_creates_event_and_returns_reply():
    r = client.post(
        "/chat",
        json={"user_id": "u1", "message": "I feel tired today", "history": []},
    )
    assert r.status_code == 200
    data = r.json()
    assert "reply" in data
    assert data.get("trace", {}).get("event_id")


def test_medication_missed_escalation():
    uid = f"u_esc_{uuid.uuid4().hex[:12]}"
    db = SessionLocal()
    try:
        user = User(external_id=uid)
        db.add(user)
        db.flush()
        base = datetime.utcnow()
        for i in range(3):
            db.add(
                Event(
                    user_id=user.id,
                    event_type="medication_missed",
                    timestamp=base - timedelta(days=i),
                    payload={},
                )
            )
        db.commit()
    finally:
        db.close()

    r = client.post(
        "/api/events",
        json={
            "event_type": "medication_missed",
            "user_id": uid,
            "payload": {},
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert "notify_clinician" in body["actions_triggered"] or any(
        "clinician" in a for a in body["actions_triggered"]
    )
