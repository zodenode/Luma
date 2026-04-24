import type { CareEvent, EscalationReasonCode } from "./types";
import { getEvents } from "./store";

const HIGH_SEVERITY_THRESHOLD = 8;
const ADHERENCE_MISS_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const ADHERENCE_MISS_THRESHOLD = 3;

export interface EscalationEvaluation {
  shouldEscalate: boolean;
  reason_code?: EscalationReasonCode;
  detail?: string;
}

export function evaluateSymptomEscalation(event: CareEvent): EscalationEvaluation {
  if (event.type !== "symptom_reported") return { shouldEscalate: false };
  const severity = Number(event.payload.severity ?? 0);
  if (severity >= HIGH_SEVERITY_THRESHOLD) {
    return {
      shouldEscalate: true,
      reason_code: "risk_signal",
      detail: `Symptom severity ${severity}/10`,
    };
  }
  return { shouldEscalate: false };
}

export async function evaluateAdherenceEscalation(userId: string): Promise<EscalationEvaluation> {
  const events = await getEvents(userId);
  const now = Date.now();
  const misses = events.filter(
    (e) =>
      e.type === "adherence_missed" &&
      now - new Date(e.occurred_at).getTime() <= ADHERENCE_MISS_WINDOW_MS,
  );
  if (misses.length >= ADHERENCE_MISS_THRESHOLD) {
    return {
      shouldEscalate: true,
      reason_code: "adherence_decline",
      detail: `${misses.length} missed-dose signals in rolling window`,
    };
  }
  return { shouldEscalate: false };
}

/** MVP stub: non-response to critical prompts (would need prompt metadata + clock). */
export function evaluateNonResponseEscalation(): EscalationEvaluation {
  return { shouldEscalate: false };
}
