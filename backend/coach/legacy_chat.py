from __future__ import annotations

from typing import Any


def legacy_chat_reply(user_message: str, history: list[dict[str, str]]) -> str:
    """
    Preserved simple chat behaviour: respond from recent history + latest message.
    No external LLM in MVP; deterministic placeholder matching prior 'basic chat' tier.
    """
    if not user_message.strip():
        return "I'm here when you're ready to share more."
    last_user = user_message.strip()
    if history:
        snippet = history[-1].get("content", "")[:80]
        return f"I hear you. You mentioned earlier: «{snippet}». Regarding what you just said: «{last_user}» — let's take that one step at a time."
    return f"Thanks for sharing: «{last_user}». What feels most important to focus on next?"


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
