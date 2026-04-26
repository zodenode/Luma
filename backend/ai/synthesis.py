"""
Derive coaching depth from structured context (no LLM).

Feeds the model explicit stance, safety framing, continuity themes, and gaps
so responses can be multi-layered instead of flat encouragement.
"""

from __future__ import annotations

from typing import Any


TREATMENT_RESPONSE_CLASSES = {
    "non_responder",
    "early_responder",
    "partial_responder",
    "strong_responder",
    "sustained_responder",
}


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


def _symptom_trend(recent: list[dict[str, Any]]) -> dict[str, Any]:
    severities: list[int] = []
    for e in recent:
        if e.get("event_type") != "symptom_reported":
            continue
        payload = e.get("payload") or {}
        if not isinstance(payload, dict):
            continue
        try:
            severities.append(int(payload.get("severity") or 0))
        except (TypeError, ValueError):
            continue

    if not severities:
        return {
            "status": "insufficient_data",
            "index": None,
            "sample_count": 0,
            "direction": "unknown",
        }
    if len(severities) < 3:
        return {
            "status": "baseline_only",
            "index": max(0, 100 - (max(severities) * 10)),
            "sample_count": len(severities),
            "direction": "unknown",
        }

    latest = severities[-3:]
    earlier = severities[:-3] or severities[:1]
    latest_avg = sum(latest) / len(latest)
    earlier_avg = sum(earlier) / len(earlier)
    delta = latest_avg - earlier_avg

    if delta >= 1.0:
        direction = "worsening"
    elif delta <= -1.0:
        direction = "improving"
    else:
        direction = "stable"

    volatility = max(severities) - min(severities)
    stability_index = max(0, min(100, round(100 - (latest_avg * 8) - (volatility * 4))))
    return {
        "status": "available",
        "index": stability_index,
        "sample_count": len(severities),
        "direction": direction,
        "latest_average": round(latest_avg, 2),
        "prior_average": round(earlier_avg, 2),
    }


def _classify_behavior_signals(recent: list[dict[str, Any]]) -> dict[str, Any]:
    categories = {
        "treatment_actions": 0,
        "supportive_actions": 0,
        "missed_actions": 0,
        "other_clinical_events": 0,
    }
    event_map = {
        "medication_taken": "treatment_actions",
        "supplement_taken": "treatment_actions",
        "protocol_step_completed": "treatment_actions",
        "prescribed_intervention_completed": "treatment_actions",
        "sleep_tracked": "supportive_actions",
        "exercise_completed": "supportive_actions",
        "nutrition_logged": "supportive_actions",
        "biomarker_submitted": "supportive_actions",
        "wearable_data_submitted": "supportive_actions",
        "lab_result_received": "supportive_actions",
        "medication_missed": "missed_actions",
        "protocol_step_missed": "missed_actions",
    }

    for event in recent:
        if not isinstance(event, dict):
            continue
        bucket = event_map.get(str(event.get("event_type") or ""))
        if bucket:
            categories[bucket] += 1
        else:
            categories["other_clinical_events"] += 1
    return categories


def _treatment_response_classification(
    adherence_rate_percent: int | None,
    symptom_trend: dict[str, Any],
    recent: list[dict[str, Any]],
) -> str:
    if adherence_rate_percent is None or symptom_trend["sample_count"] < 2:
        return "early_responder"

    direction = symptom_trend.get("direction")
    stability_index = symptom_trend.get("index") or 0
    symptom_events = symptom_trend.get("sample_count") or 0
    treatment_events = sum(
        1
        for event in recent
        if isinstance(event, dict)
        and event.get("event_type")
        in {"medication_taken", "protocol_step_completed", "prescribed_intervention_completed"}
    )

    if adherence_rate_percent < 60 or direction == "worsening":
        return "non_responder"
    if adherence_rate_percent >= 90 and direction == "improving" and stability_index >= 70:
        return "sustained_responder" if symptom_events >= 6 and treatment_events >= 6 else "strong_responder"
    if adherence_rate_percent >= 75 and direction in {"improving", "stable"}:
        return "partial_responder"
    return "early_responder"


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
    sched = state.get("prescription_schedule") or treatment.get("prescription_schedule")
    sched_brief = _schedule_brief(sched if isinstance(sched, dict) else None)
    adherence_score = state.get("adherence_score")
    adherence_rate_percent: int | None = None
    if adherence_score is not None:
        try:
            adherence_rate_percent = round(float(adherence_score) * 100)
        except (TypeError, ValueError):
            adherence_rate_percent = None
    symptom_stability = _symptom_trend(recent)
    treatment_response = _treatment_response_classification(
        adherence_rate_percent,
        symptom_stability,
        recent,
    )

    # Clinical stance: drives depth of probing vs stabilizing vs escalation tone.
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

    if not rationale_parts:
        rationale_parts.append("Risk and recent pattern support continuity and outcome monitoring.")

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

    intervention_triggers: list[str] = []
    if missed_7d > 2:
        intervention_triggers.append("sustained_non_adherence")
    if symptom_stability.get("direction") == "worsening" or symptom_peak >= 8:
        intervention_triggers.append("worsening_symptom_trend")
    if (
        adherence_rate_percent is not None
        and adherence_rate_percent >= 80
        and symptom_stability.get("direction") == "stable"
        and symptom_peak >= 4
    ):
        intervention_triggers.append("plateau_expected_response_window")

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
        priority_topics.extend(["treatment_continuity", "outcome_monitoring", "fine_tuning"])

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
                "Which part of the treatment routine has been easiest to keep consistent?",
                "Where would a small schedule adjustment reduce friction without changing the plan?",
            ],
        },
    }

    return {
        "coaching_stance": stance,
        "stance_rationale": " ".join(rationale_parts),
        "engagement_themes": themes,
        "clinical_signal_model": {
            "behavior_input_counts": _classify_behavior_signals(recent),
            "adherence_rate_percent": adherence_rate_percent,
            "symptom_stability_index": symptom_stability,
            "treatment_response_classification": treatment_response,
            "allowed_response_classes": sorted(TREATMENT_RESPONSE_CLASSES),
            "intervention_triggers": intervention_triggers,
        },
        "clinical_safety_notes": safety_notes,
        "information_gaps": gaps,
        "priority_topics": priority_topics,
        "rule_trigger_summary": rule_lines,
        "schedule_brief": sched_brief,
        "continuity_signals": {
            "recent_event_types_tail": [e.get("event_type") for e in recent[-8:] if isinstance(e, dict)],
            "symptom_severity_peak_in_window": symptom_peak,
            "medication_missed_7d": missed_7d,
        },
        "response_blueprint": blueprint,
    }
