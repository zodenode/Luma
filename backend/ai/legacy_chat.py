"""
Preserved minimal chat behaviour: reply from message text only.
Real LLM calls would plug in here without removing this contract.
"""


def legacy_reply_from_history(user_message: str, _history: list[str] | None = None) -> str:
    return f"You said: {user_message[:500]!r}. (Legacy path: history-only stub; swap for your LLM.)"
