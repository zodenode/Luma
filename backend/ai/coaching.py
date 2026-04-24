from typing import Any

# System-facing coaching contract: pass this (or equivalent) to your LLM as instructions.
COACHING_SYSTEM_DIRECTIVE = """You are a longitudinal health coach. You receive structured context:
user_state (risk, adherence, schedule summary), recent_events, active_rules, treatment_context.
Adapt tone to user_state.risk_level (low: steady supportive; medium: warm proactive;
high: urgent compassionate with safety and escalation). Use recent_events for continuity;
do not invent clinical facts not present in context. Prefer behavioural, achievable next steps."""


def build_ai_context(
    user_state: dict[str, Any],
    recent_events: list[dict[str, Any]],
    active_rules: list[dict[str, Any]],
    treatment_context: dict[str, Any],
) -> dict[str, Any]:
    """
    Interface your LLM layer should consume (plus COACHING_SYSTEM_DIRECTIVE as system prompt).

    Memory model (MVP): no separate vector store; continuity comes from recent_events
    (ordered, capped in the pipeline) and user_state snapshot. Add a memory service later
    and merge its output into treatment_context or a new top-level key.
    """
    return {
        "system_directive": COACHING_SYSTEM_DIRECTIVE,
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
    treatment_ctx = context.get("treatment_context") or {}
    risk = state.get("risk_level", "unknown")
    adherence = state.get("adherence_score")
    last_lab = state.get("last_lab_summary")
    schedule = state.get("prescription_schedule") or treatment_ctx.get("prescription_schedule")

    tone = "supportive and steady"
    if risk == "high":
        tone = "urgent but compassionate; prioritise safety and clear escalation paths"
    elif risk == "medium":
        tone = "warm and proactive; encourage small, achievable steps"

    parts = [
        f"[Coach | risk={risk} | tone={tone}]",
        f"I hear you: {user_message.strip()[:400]}",
    ]
    recent = context.get("recent_events") or []
    if isinstance(recent, list) and recent:
        tail = recent[-5:]
        summary = ", ".join(
            str(e.get("event_type", "?")) for e in tail if isinstance(e, dict)
        )
        parts.append(
            f"Recent care activity (event log, newest last): {summary}. "
            "Use this for continuity; full history is in context.recent_events."
        )

    if isinstance(schedule, dict) and schedule.get("medications"):
        med_lines = []
        for m in schedule["medications"][:12]:
            if not isinstance(m, dict):
                continue
            name = m.get("display_name") or m.get("medication_id", "medication")
            tz = m.get("timezone", "")
            dose_bits = []
            for d in m.get("doses") or []:
                if isinstance(d, dict):
                    t = d.get("time_local", "")
                    dow = d.get("days_of_week")
                    if dow:
                        dose_bits.append(f"{t} (days {dow})")
                    else:
                        dose_bits.append(f"{t} daily")
            med_lines.append(f"- {name} [{tz}]: " + "; ".join(dose_bits) if dose_bits else f"- {name}")
        parts.append("Your current schedule on file:\n" + "\n".join(med_lines))
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
