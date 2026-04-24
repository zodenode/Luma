from fastapi.testclient import TestClient

# DATABASE_URL is set in conftest before backend imports.


def test_chat_creates_event_and_returns_reply(client: TestClient):
    r = client.post("/v1/chat", json={"user_id": "u1", "message": "hello"})
    assert r.status_code == 200
    body = r.json()
    assert "reply" in body
    assert body["trace"]["event_id"]


def test_medication_escalation_after_three_misses(client: TestClient):
    last = None
    for _ in range(3):
        last = client.post("/v1/events/medication_missed", json={"user_id": "u2"})
        assert last.status_code == 200
    body = last.json()
    assert body["fired_rules"]
    actions = {a for fr in body["fired_rules"] for a in fr["actions"]}
    assert "notify_clinician" in actions
