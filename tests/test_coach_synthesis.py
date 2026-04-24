from fastapi.testclient import TestClient

from backend.ai.synthesis import compute_coaching_synthesis
from backend.main import app


def test_synthesis_escalate_after_many_misses():
    recent = [{"event_type": "medication_missed", "payload": {}} for _ in range(4)]
    state = {
        "risk_level": "high",
        "metrics": {"medication_missed_count_7d": 4},
        "prescription_schedule": None,
    }
    syn = compute_coaching_synthesis(state, recent, [], {})
    assert syn["coaching_stance"] == "escalate_support"
    assert syn["clinical_safety_notes"]


def test_chat_trace_includes_coach_synthesis():
    with TestClient(app) as client:
        r = client.post("/v1/chat", json={"user_id": "syn_user", "message": "I feel overwhelmed"})
        assert r.status_code == 200
        ctx = r.json()["trace"]["ai_context"]
    assert "coach_synthesis" in ctx
    assert ctx["coach_synthesis"]["coaching_stance"]
    assert "response_blueprint" in ctx["coach_synthesis"]
