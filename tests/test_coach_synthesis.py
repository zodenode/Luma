from fastapi.testclient import TestClient

from backend.ai.coaching import COACHING_SYSTEM_DIRECTIVE
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


def test_synthesis_adds_clinical_signal_model_without_gamified_framing():
    recent = [
        {"event_type": "medication_taken", "payload": {}},
        {"event_type": "sleep_tracked", "payload": {"hours": 7}},
        {"event_type": "symptom_reported", "payload": {"severity": 3}},
        {"event_type": "symptom_reported", "payload": {"severity": 3}},
        {"event_type": "symptom_reported", "payload": {"severity": 2}},
        {"event_type": "symptom_reported", "payload": {"severity": 1}},
    ]
    state = {"risk_level": "low", "adherence_score": 0.93, "metrics": {}}

    syn = compute_coaching_synthesis(state, recent, [], {})
    model = syn["clinical_signal_model"]

    assert model["behavior_input_counts"]["treatment_actions"] == 1
    assert model["behavior_input_counts"]["supportive_actions"] == 1
    assert model["adherence_rate_percent"] == 93
    assert model["symptom_stability_index"]["direction"] == "improving"
    assert model["treatment_response_classification"] in model["allowed_response_classes"]
    assert syn["priority_topics"] == ["treatment_continuity", "outcome_monitoring", "fine_tuning"]


def test_chat_response_uses_clinical_adherence_language_not_rewards():
    with TestClient(app) as client:
        r = client.post(
            "/v1/chat",
            json={"user_id": "clinical_copy_user", "message": "I missed a dose and my symptoms changed"},
        )
        assert r.status_code == 200
        body = r.json()

    reply = body["reply"].lower()
    directive = body["trace"]["ai_context"]["system_directive"]
    assert directive == COACHING_SYSTEM_DIRECTIVE
    assert "clinical trajectory" in reply
    assert "treatment response classification" in reply
    assert "not a penalty" in reply
    for forbidden in ["points", "xp", "streak", "leaderboard", "ranking"]:
        assert forbidden not in reply
