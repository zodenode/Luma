import type { TreatmentState } from "./types";

export interface CareStateDTO {
  stage: string;
  medication_status: string;
  adherence_indicator: string;
  adherence_score: number | null;
  next_recommended_action: string | null;
  active_medication: Record<string, unknown> | null;
  key_symptoms: string[];
  last_interaction_at: string | null;
}

export function treatmentToCareState(t?: TreatmentState): CareStateDTO {
  const med = t?.medication;
  let medication_status = "none";
  if (med) {
    if (med.state === "not_started") medication_status = "prescribed";
    else if (med.state === "shipped") medication_status = "shipped";
    else if (med.state === "active" || med.state === "delivered") medication_status = "active";
    else medication_status = med.state;
  }
  return {
    stage: t?.stage ?? "intake",
    medication_status,
    adherence_indicator: t?.adherence_indicator ?? "unknown",
    adherence_score: t?.adherence_score ?? null,
    next_recommended_action: t?.next_recommended_action ?? null,
    active_medication: med
      ? { name: med.name, dosage: med.dosage ?? null, state: med.state }
      : null,
    key_symptoms: t?.key_symptoms ?? [],
    last_interaction_at: t?.last_interaction_at ?? null,
  };
}
