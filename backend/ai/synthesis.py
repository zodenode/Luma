"""
Derive coaching depth from structured context (no LLM).

Feeds the model explicit stance, safety framing, continuity themes, and gaps
so responses can be multi-layered instead of flat encouragement.
"""

from __future__ import annotations

from typing import Any


def _schedule_brief(schedule: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(schedule, dict):
        return {"has_schedule": False, "medication_count": 0, "dose_slot_count": 0}
    meds = schedule.get("medications") or []
    if not isinstance(meds, list):
        return {"has_schedule": False, "medication_count": 0, "dose_slot_count": 0}
    slots = 0
    for m in meds:
        if isinstance(m, dict):
            slots += len(m.get("doses") or [])
    return {
        "has_schedule": len(meds) > 0,
        "medication_count": len(meds),
        "dose_slot_count": slots,
    }


def _recent_symptom_peak(recent: list[dict[str, Any]]) -> int:
    peak = 0
    for e in recent:
        if e.get("event_type") != "symptom_reported":
            continue
        p = e.get("payload") or {}
        if isinstance(p, dict):
            try:
                peak = max(peak, int(p.get("severity") or 0))
            except (TypeError, ValueError):
                pass
    return peak


def _event_themes(recent: list[dict[str, Any]], limit: int = 25) -> list[str]:
    """Ordered themes from recent tail (newest-heavy via reverse scan)."""
    themes: list[str] = []
    seen: set[str] = set()
    for e in reversed(recent[-limit:]):
        et = e.get("event_type")
        if not et or not isinstance(e, dict):
            continue
        if et == "medication_missed" and "adherence_strain" not in seen:
            themes.append("adherence_strain")
            seen.add("adherence_strain")
        elif et == "symptom_reported" and "symptom_burden" not in seen:
            themes.append("symptom_burden")
            seen.add("symptom_burden")
        elif et == "consult_completed" and "care_navigation" not in seen:
            themes.append("care_navigation")
            seen.add("care_navigation")
        elif et == "lab_result_received" and "biomarker_context" not in seen:
            themes.append("biomarker_context")
            seen.add("biomarker_context")
        elif et == "chat_message_received" and "ongoing_dialogue" not in seen:
            themes.append("ongoing_dialogue")
            seen.add("ongoing_dialogue")
        elif et == "prescription_schedule_set" and "schedule_change" not in seen:
            themes.append("schedule_change")
            seen.add("schedule_change")
        elif et == "daily_checkin_completed" and "retention_rhythm" not in seen:
            themes.append("retention_rhythm")
            seen.add("retention_rhythm")
        elif et == "weekly_reflection_submitted" and "longitudinal_story" not in seen:
            themes.append("longitudinal_story")
            seen.add("longitudinal_story")
        elif et == "metric_recorded" and "self_tracking" not in seen:
            themes.append("self_tracking")
            seen.add("self_tracking")
        elif et == "cost_barrier_noted" and "access_stress" not in seen:
            themes.append("access_stress")
            seen.add("access_stress")
    return list(reversed(themes))


def compute_coaching_synthesis(
    user_state: dict[str, Any],
    recent_events: list[dict[str, Any]],
    active_rules: list[dict[str, Any]],
    treatment_context: dict[str, Any],
) -> dict[str, Any]:
    state = user_state or {}
    recent = recent_events if isinstance(recent_events, list) else []
    rules = active_rules if isinstance(active_rules, list) else []
    treatment = treatment_context or {}

    risk = str(state.get("risk_level") or "unknown")
    metrics = state.get("metrics") or {}
    if not isinstance(metrics, dict):
        metrics = {}

    missed_7d = int(metrics.get("medication_missed_count_7d") or 0)
    symptom_peak = _recent_symptom_peak(recent)
    retention = state.get("retention") if isinstance(state.get("retention"), dict) else {}
    sched = state.get("prescription_schedule") or treatment.get("prescription_schedule")
    sched_brief = _schedule_brief(sched if isinstance(sched, dict) else None)

    # Coaching stance: drives depth of probing vs stabilizing vs escalation tone
    stance = "maintain_momentum"
    rationale_parts: list[str] = []

    if risk == "high" or missed_7d > 2 or symptom_peak >= 8:
        stance = "escalate_support"
        rationale_parts.append("Elevated risk from state metrics or recent severe symptoms / misses.")
    elif missed_7d > 0:
        stance = "adherence_repair"
        rationale_parts.append("Recent missed doses; prioritize barrier exploration without shame.")
    elif any(e.get("event_type") == "consult_completed" for e in recent[-8:]):
        stance = "onboard_integrate"
        rationale_parts.append("Recent consult; bridge clinical plan to daily behaviour.")
    elif symptom_peak >= 4:
        stance = "symptom_stabilize"
        rationale_parts.append("Meaningful symptom intensity; validate and co-plan coping.")
    elif any(e.get("event_type") == "cost_barrier_noted" for e in recent[-6:]):
        stance = "adherence_repair"
        rationale_parts.append("Recent cost or access stress; explore barriers and practical navigation.")

    if not rationale_parts:
        rationale_parts.append("Risk and recent pattern support continuity and reinforcement.")

    themes = _event_themes(recent)

    safety_notes: list[str] = []
    if risk == "high":
        safety_notes.append(
            "Risk is high: use clear safety netting (when to seek urgent care), "
            "avoid minimizing, and defer diagnosis or med changes to clinicians."
        )
    if symptom_peak >= 8:
        safety_notes.append(
            "Recent symptom severity in context was high; explicitly invite urgent "
            "evaluation if red-flag symptoms apply, without alarmism."
        )
    if missed_7d > 2:
        safety_notes.append(
            "Repeated missed doses: mention clinician/pharmacist follow-up as appropriate "
            "to rule out side effects, cost, or misunderstanding of schedule."
        )

    gaps: list[str] = []
    if not sched_brief["has_schedule"]:
        gaps.append(
            "No structured prescription schedule in state; do not assume specific dose times "
            "or drug names unless the user states them in this turn."
        )
    if not recent:
        gaps.append("Sparse recent_events; lean on explicit user message and avoid inventing history.")

    streak = 0
    if retention:
        dc = retention.get("daily_checkin") or {}
        if isinstance(dc, dict):
            try:
                streak = int(dc.get("streak_current") or 0)
            except (TypeError, ValueError):
                streak = 0
        if streak == 0 and not any(e.get("event_type") == "daily_checkin_completed" for e in recent[-14:]):
            gaps.append(
                "No recent daily check-ins in timeline; do not assume journaling or streak data unless user_state.retention shows it."
            )

    priority_topics: list[str] = []
    if stance == "escalate_support":
        priority_topics.extend(["safety", "adherence_barriers", "clinical_touchpoints"])
    elif stance == "adherence_repair":
        priority_topics.extend(["adherence_barriers", "habit_environment", "schedule_alignment"])
    elif stance == "onboard_integrate":
        priority_topics.extend(["care_plan_translation", "expectations", "first_week_goals"])
    elif stance == "symptom_stabilize":
        priority_topics.extend(["symptom_triggers", "self_monitoring", "when_to_escalate"])
    else:
        priority_topics.extend(["sustain_habits", "motivation", "fine_tuning"])

    if retention:
        priority_topics.append("longitudinal_continuity")
        wmem = (retention.get("longitudinal") or {}).get("weekly_reflection_memory") or []
        if isinstance(wmem, list) and wmem:
            priority_topics.append("week_over_week_differences")

    rule_lines: list[str] = []
    for r in rules[:8]:
        if not isinstance(r, dict):
            continue
        name = r.get("name") or r.get("rule_id") or "rule"
        acts = r.get("actions") or []
        rule_lines.append(f"{name} → {', '.join(str(a) for a in acts)}")

    blueprint = {
        "sections": [
            "reflect_user",
            "validate_context",
            "depth_probe",
            "micro_plan",
            "safety_net",
            "closing",
        ],
        "depth_probe_prompts_by_stance": {
            "escalate_support": [
                "What felt hardest about sticking to the plan this week—side effects, forgetfulness, cost, or something else?",
                "When a dose is missed, what is usually happening in your day right before that moment?",
            ],
            "adherence_repair": [
                "If you could change one thing about how doses fit into your routine, what would it be?",
                "What reminder or environmental cue has worked for you before, even briefly?",
            ],
            "onboard_integrate": [
                "What did your clinician emphasize as the top priority for the next few days?",
                "What part of the new plan feels clearest, and what still feels fuzzy?",
            ],
            "symptom_stabilize": [
                "Do symptoms follow a daily pattern (time of day, meals, activity)?",
                "What have you already tried that helped even a little?",
            ],
            "maintain_momentum": [
                "What is one habit from last week you are quietly proud of?",
                "Where do you want slightly more structure versus more flexibility?",
            ],
        },
    }

    wmem_for_prompts = (
        (retention.get("longitudinal") or {}).get("weekly_reflection_memory") or []
        if retention
        else []
    )
    if isinstance(wmem_for_prompts, list) and wmem_for_prompts:
        mm = blueprint["depth_probe_prompts_by_stance"]["maintain_momentum"]
        blueprint["depth_probe_prompts_by_stance"]["maintain_momentum"] = list(mm) + [
            "Compared to last week, what did you do differently — even in a small way?",
            "What does your latest logged metric or reflection suggest about what is working?",
        ]

    return {
        "coaching_stance": stance,
        "stance_rationale": " ".join(rationale_parts),
        "engagement_themes": themes,
        "clinical_safety_notes": safety_notes,
        "information_gaps": gaps,
        "priority_topics": priority_topics,
        "rule_trigger_summary": rule_lines,
        "schedule_brief": sched_brief,
        "continuity_signals": {
            "recent_event_types_tail": [e.get("event_type") for e in recent[-8:] if isinstance(e, dict)],
            "symptom_severity_peak_in_window": symptom_peak,
            "medication_missed_7d": missed_7d,
            "retention_streak": streak,
            "retention_level": (retention.get("gamification") or {}).get("level") if retention else None,
            "weekly_reflection_tail": (retention.get("longitudinal") or {}).get("weekly_reflection_memory")[-2:]
            if retention
            else [],
        },
        "response_blueprint": blueprint,
    }
