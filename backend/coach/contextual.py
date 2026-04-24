from __future__ import annotations

from typing import Any

from backend.coach.legacy_chat import legacy_chat_reply


def _tone_for_risk(risk: str) -> str:
    if risk == "high":
        return "warm, concise, and safety-oriented"
    if risk == "medium":
        return "supportive and structured"
    return "encouraging and conversational"


def contextual_coach_reply(
    user_message: str,
    history: list[dict[str, str]],
    ai_context: dict[str, Any],
    coaching_hints: list[str],
) -> str:
    """
    Wraps legacy chat: same baseline reply, enriched with structured care context,
    risk-adapted tone, and light behavioural guidance.
    """
    base = legacy_chat_reply(user_message, history)
    state = ai_context.get("user_state") or {}
    risk = str(state.get("risk_level", "low"))
    adherence = state.get("adherence_score")
    tone = _tone_for_risk(risk)

    parts = [f"[Tone: {tone}] {base}"]

    if coaching_hints:
        parts.append("Suggested next steps from your care plan: " + "; ".join(coaching_hints))

    if adherence is not None and float(adherence) < 0.85:
        parts.append(
            "Behavioural tip: tie your medication to an existing daily habit "
            "(for example, morning coffee) to make adherence easier to remember."
        )

    recent = ai_context.get("recent_events") or []
    if recent:
        et = recent[0].get("event_type")
        if et == "symptom_reported":
            parts.append(
                "For symptoms: track intensity 0–10 daily and note what changed before they started."
            )
        elif et == "consult_completed":
            parts.append("Welcome to the next phase of your plan — small consistent actions beat big spikes.")

    return "\n\n".join(parts)
