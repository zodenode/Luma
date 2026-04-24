import { appendEscalation, getEvents, mutate } from "./store";
import type { CareEvent, EscalationReasonCode, EscalationRecord } from "./types";

const MISSED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MISSED_THRESHOLD = 3;

export async function createEscalation(args: {
  userId: string;
  reason_code: EscalationReasonCode;
  linked_event_id?: string;
}): Promise<EscalationRecord> {
  return appendEscalation({
    user_id: args.userId,
    reason_code: args.reason_code,
    status: "open",
    linked_event_id: args.linked_event_id,
  });
}

/**
 * Rolling window count of adherence_missed for MVP rule engine (plan §8).
 */
export async function countAdherenceMissedInWindow(
  userId: string,
  windowMs: number = MISSED_WINDOW_MS,
): Promise<number> {
  const events = await getEvents(userId);
  const cutoff = Date.now() - windowMs;
  return events.filter(
    (e) =>
      e.type === "adherence_missed" && new Date(e.occurred_at).getTime() >= cutoff,
  ).length;
}

export async function evaluateEscalationAfterEvent(event: CareEvent): Promise<void> {
  if (event.type === "adherence_missed") {
    const n = await countAdherenceMissedInWindow(event.user_id);
    if (n >= MISSED_THRESHOLD) {
      const open = await mutate(async (db) =>
        db.escalations.some(
          (x) =>
            x.user_id === event.user_id &&
            x.status === "open" &&
            x.reason_code === "adherence_decline",
        ),
      );
      if (!open) {
        await createEscalation({
          userId: event.user_id,
          reason_code: "adherence_decline",
          linked_event_id: event.id,
        });
      }
    }
  }
}

export function symptomEscalationRecommended(event: CareEvent): boolean {
  if (event.type !== "symptom_reported") return false;
  const severity = Number(event.payload.severity ?? 0);
  return severity >= 8;
}
