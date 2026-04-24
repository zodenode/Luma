from typing import Any


def build_ai_context(
    user_state: dict[str, Any],
    recent_events: list[dict[str, Any]],
    active_rules: list[dict[str, Any]],
    treatment_context: dict[str, Any],
) -> dict[str, Any]:
    return {
        "user_state": user_state,
        "recent_events": recent_events,
        "active_rules": active_rules,
        "treatment_context": treatment_context,
    }


def generate_coaching_response(
    user_message: str,
    context: dict[str, Any],
) -> str:
    """
    Wrap legacy chat: deterministic MVP coach that uses structured context.
    Replace internals with your LLM call; keep this function as the seam.
    """
    state = context.get("user_state") or {}
    risk = state.get("risk_level", "unknown")
    adherence = state.get("adherence_score")
    last_lab = state.get("last_lab_summary")

    tone = "supportive and steady"
    if risk == "high":
        tone = "urgent but compassionate; prioritise safety and clear escalation paths"
    elif risk == "medium":
        tone = "warm and proactive; encourage small, achievable steps"

    parts = [
        f"[Coach | risk={risk} | tone={tone}]",
        f"I hear you: {user_message.strip()[:400]}",
    ]
    if adherence is not None:
        parts.append(
            f"Your recent adherence score is about {float(adherence):.0%}; "
            "small consistent wins matter more than perfection."
        )
    if last_lab:
        parts.append(
            "I have a recent lab summary on file; if anything feels off physically, "
            "prioritise clinician guidance alongside these coaching steps."
        )
    parts.append(
        "Behavioural guidance: pick one concrete action for the next 24 hours "
        "(e.g. one scheduled dose, a 10-minute walk, or a symptom check-in) and "
        "reply with how it went."
    )
    return "\n\n".join(parts)
