from typing import Any

from backend.ai.synthesis import compute_coaching_synthesis

# System-facing coaching contract: pass this (or equivalent) to your LLM as instructions.
COACHING_SYSTEM_DIRECTIVE = """You are an AI coaching and clinical adherence system integrated into a digital health app.

Your role is to track, interpret, and optimise user behaviour related to treatment adherence, symptom response, and clinically relevant lifestyle inputs. You are not a general productivity or lifestyle gamification system.

You receive a structured context bundle:
- user_state: materialised snapshot (risk, adherence, prescription_schedule summary, labs, metrics)
- recent_events: append-only care timeline (types, timestamps, payloads) — your primary continuity signal
- active_rules: rules that fired on this turn (names + actions) — signals system escalation or follow-up
- treatment_context: merge of treatment-specific fields for this interaction
- coach_synthesis: derived meta-layer (clinical stance, safety notes, information gaps, response blueprint, clinical_signal_model)

Core responsibility:
1. Convert user-reported and device-tracked actions into treatment adherence signals, symptom and outcome trends, clinically relevant behavioural insights, and intervention recommendations when necessary.
2. Prioritise health outcome interpretation over engagement, retention, motivation mechanics, or novelty.

Behaviour input model:
- Treatment actions: medication intake, supplement/protocol adherence, and prescribed interventions. Weight positively in adherence interpretation.
- Supportive actions: sleep tracking, protocol exercise, relevant nutrition logs, biomarker or wearable submissions. Treat as supportive outcome signals.
- Missed actions: missed medication or missed protocol steps. Flag as adherence degradation, not as a penalty or failure.

Internal clinical model only:
- Adherence rate (0-100%)
- Symptom stability index (trend-based)
- Treatment response classification: non_responder, early_responder, partial_responder, strong_responder, sustained_responder

Never expose points, XP, levels, streak mechanics, reward randomness, leaderboards, public rankings, or identity-based competitive framing. Replace "levels" with treatment response classification language.

Feedback style:
1. Reflect what the user actually said; connect it to 1-2 concrete signals from recent_events, user_state, or coach_synthesis.clinical_signal_model.
2. Layer your response: neutral acknowledgement -> clinical sense-making (patterns, not blame) -> one focused adherence/outcome plan (24-72h) with specificity.
3. Tone is set by user_state.risk_level AND coach_synthesis.coaching_stance:
   - maintain_momentum: neutral, precise continuity support; no streak or reward framing
   - adherence_repair: curious, non-judgmental barrier exploration; problem-solve around treatment continuity
   - symptom_stabilize: validate symptom burden; co-plan monitoring and coping; clear escalation guidance
   - onboard_integrate: translate clinical plan into daily life; clarify expectations and first steps
   - escalate_support: urgent-compassionate; prioritise safety; favour clinician touchpoints over DIY fixes
4. Use coach_synthesis.clinical_safety_notes and information_gaps literally: never fill gaps with invented
   clinical facts. If schedule or meds are unknown in context, ask focused questions instead of assuming.
5. Use coach_synthesis.response_blueprint.sections as an outline for longer replies when appropriate.
6. Prefer behavioural, achievable steps; avoid medical diagnosis or changing prescriptions unless the user
   is only repeating what their clinician already said in context.
7. If social comparison is enabled in product context, only use anonymised cohort benchmarks; never use leaderboards or rankings.
8. Trigger interventions only for clinically relevant patterns such as sustained non-adherence, worsening symptom trends, or plateau in the expected response window.

System objective:
Maximise treatment adherence stability, symptom improvement clarity, and long-term behavioural independence from the app. Do not maximise session frequency, engagement time, or addictive retention loops.

Do not invent labs, diagnoses, or medication schedules not present in context. Keep UX copy easy, clear, and clinically grounded."""


def build_ai_context(
    user_state: dict[str, Any],
    recent_events: list[dict[str, Any]],
    active_rules: list[dict[str, Any]],
    treatment_context: dict[str, Any],
) -> dict[str, Any]:
    """
    Interface your LLM layer should consume (plus COACHING_SYSTEM_DIRECTIVE as system prompt).

    Memory model (MVP): no separate vector store; continuity comes from recent_events
    (ordered, capped in the pipeline) and user_state snapshot. coach_synthesis adds
    explicit reasoning scaffolding for deeper responses. Add retrieval memory later
    and merge into treatment_context or coach_synthesis.
    """
    synthesis = compute_coaching_synthesis(user_state, recent_events, active_rules, treatment_context)
    return {
        "system_directive": COACHING_SYSTEM_DIRECTIVE,
        "user_state": user_state,
        "recent_events": recent_events,
        "active_rules": active_rules,
        "treatment_context": treatment_context,
        "coach_synthesis": synthesis,
    }


def _format_rules_for_coach(rules: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for r in rules[:6]:
        if not isinstance(r, dict):
            continue
        name = r.get("name") or "rule"
        acts = ", ".join(str(a) for a in (r.get("actions") or []))
        lines.append(f"• {name} ({acts})" if acts else f"• {name}")
    return "\n".join(lines) if lines else "(none this turn)"


def _format_safety(synthesis: dict[str, Any]) -> str:
    notes = synthesis.get("clinical_safety_notes") or []
    if not notes:
        return ""
    return "Safety framing for this turn:\n" + "\n".join(f"• {n}" for n in notes)


def _format_gaps(synthesis: dict[str, Any]) -> str:
    gaps = synthesis.get("information_gaps") or []
    if not gaps:
        return ""
    return "Do not assume beyond context:\n" + "\n".join(f"• {g}" for g in gaps)


def _depth_questions(synthesis: dict[str, Any]) -> list[str]:
    stance = str(synthesis.get("coaching_stance") or "maintain_momentum")
    bp = synthesis.get("response_blueprint") or {}
    prompts = (bp.get("depth_probe_prompts_by_stance") or {}).get(stance) or (
        bp.get("depth_probe_prompts_by_stance") or {}
    ).get("maintain_momentum", [])
    return list(prompts)[:2]


def generate_coaching_response(
    user_message: str,
    context: dict[str, Any],
) -> str:
    """
    Deterministic coach that mirrors a deeper multi-section response.
    Replace with your LLM; pass the full context dict including coach_synthesis.
    """
    state = context.get("user_state") or {}
    treatment_ctx = context.get("treatment_context") or {}
    synthesis = context.get("coach_synthesis") or compute_coaching_synthesis(
        state,
        context.get("recent_events") or [],
        context.get("active_rules") or [],
        treatment_ctx,
    )
    rules = context.get("active_rules") or []

    risk = state.get("risk_level", "unknown")
    stance = synthesis.get("coaching_stance", "maintain_momentum")
    adherence = state.get("adherence_score")
    last_lab = state.get("last_lab_summary")
    schedule = state.get("prescription_schedule") or treatment_ctx.get("prescription_schedule")

    tone = "neutral and clinically grounded"
    if risk == "high":
        tone = "urgent but compassionate; prioritise safety and clear escalation paths"
    elif risk == "medium":
        tone = "proactive and clinically grounded; focus on one achievable next step"

    msg = user_message.strip()[:600]

    sections: list[str] = []

    sections.append(
        f"## Reflect\nI hear you: {msg}\n\n"
        f"_Stance: **{stance}** (risk **{risk}**, tone: {tone})_\n"
        f"_Why this stance: {synthesis.get('stance_rationale', '')}_"
    )

    cont = synthesis.get("continuity_signals") or {}
    themes = synthesis.get("engagement_themes") or []
    tail = cont.get("recent_event_types_tail") or []
    sections.append(
        "## Clinical context\n"
        f"From your recent care timeline: {', '.join(str(x) for x in tail) or '—'}.\n"
        f"Clinical themes: {', '.join(themes) or 'general continuity'}.\n"
        f"Priority angles for this reply: {', '.join(synthesis.get('priority_topics') or [])}."
    )

    if rules:
        sections.append("## System context\nRules that fired this turn:\n" + _format_rules_for_coach(rules))

    sched_block = ""
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
            sig = m.get("instructions")
            sig_s = f" — {sig}" if sig else ""
            med_lines.append(
                f"- **{name}**{sig_s} [{tz}]: " + ("; ".join(dose_bits) if dose_bits else "(no dose times)")
            )
        sched_block = "## Your schedule on file\n" + "\n".join(med_lines)
        sections.append(sched_block)

    metrics = state.get("metrics") or {}
    if isinstance(metrics, dict) and metrics:
        sections.append(
            "## Adherence snapshot\n"
            f"- Missed doses (7d): {metrics.get('medication_missed_count_7d', '—')}\n"
            f"- Missed doses (30d): {metrics.get('medication_missed_count_30d', '—')}\n"
            + (
                f"- Modelled adherence score: ~{float(adherence):.0%}\n"
                if adherence is not None
                else ""
            )
            + "These values guide continuity planning; they are not a penalty."
        )
    elif adherence is not None:
        sections.append(
            f"## Adherence snapshot\nAbout **{float(adherence):.0%}** on our simple model; "
            "we can deepen this once your schedule and dose events are logged more tightly."
        )

    clinical_model = synthesis.get("clinical_signal_model") or {}
    if isinstance(clinical_model, dict):
        symptom_index = clinical_model.get("symptom_stability_index") or {}
        intervention_triggers = clinical_model.get("intervention_triggers") or []
        response_class = clinical_model.get("treatment_response_classification")
        signal_lines = [
            f"- Treatment response classification: {response_class or 'early_responder'}",
        ]
        if isinstance(symptom_index, dict):
            signal_lines.append(
                "- Symptom stability: "
                f"{symptom_index.get('direction', 'unknown')} "
                f"(index: {symptom_index.get('index', 'insufficient data')})"
            )
        if intervention_triggers:
            signal_lines.append(
                "- Intervention trigger(s): "
                + ", ".join(str(trigger) for trigger in intervention_triggers)
            )
        sections.append(
            "## Clinical trajectory\n"
            + "\n".join(signal_lines)
            + "\nThese signals are used for treatment interpretation, not rewards."
        )

    if last_lab:
        sections.append(
            "## Labs\nThere is a recent lab summary in your record. "
            "I will not interpret numbers here; if something feels off in your body, "
            "pair this chat with your clinician's guidance."
        )

    safety = _format_safety(synthesis)
    if safety:
        sections.append("## Safety\n" + safety)

    gaps = _format_gaps(synthesis)
    if gaps:
        sections.append("## Gaps\n" + gaps)

    dq = _depth_questions(synthesis)
    if dq:
        sections.append(
            "## Clarifying question\nOne of these would make the next recommendation more precise:\n"
            + "\n".join(f"- {q}" for q in dq)
        )

    sections.append(
        "## Next 24–72 hours\n"
        "Choose **one** clinically relevant action: confirm the next dose time, log the next symptom check-in, "
        "or note the main barrier to following the protocol. Reply with what happened so the plan can stay specific."
    )

    return "\n\n".join(sections)
