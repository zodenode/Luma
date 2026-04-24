from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.ai.legacy_chat import legacy_reply_from_history
from backend.models import Event, Rule, UserState


def build_ai_context(
    db: Session,
    *,
    user_id: str,
    state: UserState,
    recent_limit: int = 20,
    matched_rules: list[tuple[Rule, list[str]]],
    treatment_context: dict | None,
) -> dict:
    recent_q = (
        select(Event)
        .where(Event.user_id == user_id)
        .order_by(Event.timestamp.desc())
        .limit(recent_limit)
    )
    recent = list(db.scalars(recent_q).all())
    recent.reverse()

    active_rules_payload = [
        {"rule_id": r.id, "name": r.name, "actions": acts, "definition": r.definition} for r, acts in matched_rules
    ]

    return {
        "user_state": {
            "adherence_score": state.adherence_score,
            "risk_level": state.risk_level,
            "active_treatment_status": state.active_treatment_status,
            "last_lab_summary": state.last_lab_summary,
            "last_interaction_at": state.last_interaction_at.isoformat() if state.last_interaction_at else None,
        },
        "recent_events": [
            {"event_type": e.event_type, "timestamp": e.timestamp.isoformat(), "payload": e.payload} for e in recent
        ],
        "active_rules": active_rules_payload,
        "treatment_context": treatment_context or {},
    }


def _tone_for_risk(risk: str) -> str:
    return {"high": "urgent, supportive, concise", "moderate": "warm, structured", "elevated": "attentive"}.get(
        risk, "friendly, coaching"
    )


def generate_coaching_reply(
    user_message: str,
    *,
    context: dict,
    history: list[str] | None = None,
) -> str:
    """
    Wrap legacy chat: same entrypoint for the model, but prompt is enriched with care context.
    Replace legacy_reply_from_history with your production LLM while keeping this wrapper.
    """
    state = context.get("user_state") or {}
    risk = state.get("risk_level") or "low"
    tone = _tone_for_risk(risk)
    events = context.get("recent_events") or []
    rules = context.get("active_rules") or []
    treat = context.get("treatment_context") or {}

    coaching_hints = []
    if risk == "high":
        coaching_hints.append("Acknowledge adherence difficulty; suggest concrete next step and offer clinician follow-up.")
    if any(e.get("event_type") == "symptom_reported" for e in events[-5:]):
        coaching_hints.append("Address recent symptoms with safe self-care guidance and when to escalate.")
    if treat.get("plan"):
        coaching_hints.append(f"Align advice with treatment plan: {treat.get('plan')}")

    preamble = (
        f"[Care context | tone={tone} | risk={risk} | adherence={state.get('adherence_score')} | "
        f"active_rules={len(rules)}]\n"
        + ("\n".join(coaching_hints) + "\n" if coaching_hints else "")
    )
    base = legacy_reply_from_history(user_message, history)
    return preamble + "\n---\n" + base


def now_utc() -> datetime:
    return datetime.now(timezone.utc)
