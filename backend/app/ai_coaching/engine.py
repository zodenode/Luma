from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from core.rules.engine import RuleMatch
from app.models import Event, User, UserState


def _state_to_dict(st: UserState) -> dict[str, Any]:
    return {
        "adherence_score": st.adherence_score,
        "risk_level": st.risk_level,
        "active_treatment_status": st.active_treatment_status,
        "last_lab_summary": st.last_lab_summary,
        "last_interaction_at": st.last_interaction_at.isoformat()
        if st.last_interaction_at
        else None,
        "snapshot": st.snapshot or {},
    }


def _recent_events(db: Session, user_id: int, limit: int = 10) -> list[dict[str, Any]]:
    q = (
        select(Event)
        .where(Event.user_id == user_id)
        .order_by(Event.timestamp.desc())
        .limit(limit)
    )
    rows = db.execute(q).scalars().all()
    out: list[dict[str, Any]] = []
    for e in reversed(rows):
        out.append(
            {
                "id": e.id,
                "event_type": e.event_type,
                "timestamp": e.timestamp.isoformat(),
                "payload": e.payload or {},
            }
        )
    return out


def build_coaching_context(
    db: Session,
    user: User,
    state: UserState,
    matches: list[RuleMatch],
    treatment_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "user_state": _state_to_dict(state),
        "recent_events": _recent_events(db, user.id),
        "active_rules": [
            {"id": m.rule_id, "name": m.rule_name, "actions": m.actions}
            for m in matches
        ],
        "treatment_context": treatment_context or {},
    }


def _tone_for_risk(risk: str) -> str:
    if risk == "high":
        return "direct, supportive, and safety-oriented"
    if risk == "medium":
        return "warm and encouraging with clear next steps"
    return "friendly and motivational"


def generate_chat_reply(
    user_message: str,
    history: list[dict[str, str]] | None,
    coaching_context: dict[str, Any],
) -> str:
    """
    Wraps prior chat behaviour: still uses message + history, but adds
    structured care context. MVP uses a deterministic template (no external LLM).
    """
    state = coaching_context.get("user_state") or {}
    risk = state.get("risk_level", "low")
    tone = _tone_for_risk(risk)
    adherence = state.get("adherence_score", 1.0)
    last_sym = (state.get("snapshot") or {}).get("last_symptom")
    rules = coaching_context.get("active_rules") or []

    parts = [
        f"(Coaching tone: {tone}.)",
        f"I hear you: {user_message.strip()[:500]}",
    ]
    if last_sym:
        parts.append(
            f"I see you recently noted {last_sym}; let's keep monitoring how that feels."
        )
    if adherence < 0.85:
        parts.append(
            "Staying on track with medications really helps outcomes; "
            "small wins count—would a simple reminder rhythm help?"
        )
    if rules:
        parts.append(
            "Your care plan flagged a follow-up; "
            "I'll keep this focused on one practical step you can take today."
        )
    parts.append(
        "Behavioural guidance: pick one concrete action in the next hour "
        "(e.g. a 5-minute walk, a glass of water, or taking the next dose on time) "
        "and notice how you feel afterward."
    )
    if history:
        parts.append(
            f"(Continuing our thread of {len(history)} prior message(s) on your side.)"
        )
    return " ".join(parts)
