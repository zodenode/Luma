import { appendKPIEvent, getEvents, hasKPIEvent } from "./store";
import type { CareEvent } from "./types";

const RETENTION_WINDOWS = [7, 30, 90] as const;

export async function emitRetentionCohortMarkers(userId: string, consultEvent: CareEvent): Promise<void> {
  const cohort = consultEvent.occurred_at;
  for (const days of RETENTION_WINDOWS) {
    await appendKPIEvent(userId, "user_retention_window", {
      window_days: days,
      cohort_consult_at: cohort,
      consult_event_id: consultEvent.id,
    });
  }
}

const MEANINGFUL_AFTER_CONSULT: CareEvent["type"][] = [
  "adherence_confirmed",
  "symptom_reported",
  "user_checkin",
  "request_help",
];

export async function emitConsultSecondActionIfNeeded(userId: string, triggerEvent: CareEvent): Promise<void> {
  if (await hasKPIEvent(userId, "consult_second_action")) return;
  const eventsDesc = await getEvents(userId);
  const consult = eventsDesc.find((e) => e.type === "consult_completed");
  if (!consult) return;
  const consultTs = new Date(consult.occurred_at).getTime();
  const after = eventsDesc.filter((e) => new Date(e.occurred_at).getTime() >= consultTs);
  const meaningful = after.filter((e) => MEANINGFUL_AFTER_CONSULT.includes(e.type));
  if (meaningful.length >= 2) {
    await appendKPIEvent(userId, "consult_second_action", {
      trigger_event_id: triggerEvent.id,
      meaningful_count: meaningful.length,
    });
  }
}
