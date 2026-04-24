import { appendKpiMarker, getEvents, mutate } from "./store";
import type { EventType } from "./types";

/**
 * Lightweight funnel markers for plan §10 (Slice E).
 */
export async function recordKpiAfterEvent(userId: string, type: EventType): Promise<void> {
  if (type === "consult_completed") {
    await appendKpiMarker({
      user_id: userId,
      type: "kpi_retention_window",
      payload: { window: "consult_completed", at: new Date().toISOString() },
    });
  }

  if (type === "user_checkin" || type === "adherence_confirmed" || type === "symptom_reported") {
    const events = await getEvents(userId);
    const chron = [...events].reverse();
    const consultIdx = chron.findIndex((e) => e.type === "consult_completed");
    if (consultIdx >= 0) {
      const afterConsult = chron.slice(consultIdx + 1);
      const meaningfulAfter = afterConsult.filter(
        (e) =>
          e.type === "user_checkin" ||
          e.type === "adherence_confirmed" ||
          e.type === "symptom_reported",
      );
      if (meaningfulAfter.length >= 2) {
        const already = await mutate(async (db) =>
          db.kpi_markers.some(
            (m) => m.user_id === userId && m.type === "kpi_consult_second_action",
          ),
        );
        if (!already) {
          await appendKpiMarker({
            user_id: userId,
            type: "kpi_consult_second_action",
            payload: { at: new Date().toISOString() },
          });
        }
      }
    }
  }

  if (type === "adherence_confirmed" || type === "adherence_missed") {
    await appendKpiMarker({
      user_id: userId,
      type: "kpi_adherence_ratio",
      payload: { event_type: type, at: new Date().toISOString() },
    });
  }
}

export async function recordAssistantEngagement(userId: string): Promise<void> {
  await appendKpiMarker({
    user_id: userId,
    type: "kpi_weekly_engagement",
    payload: { at: new Date().toISOString() },
  });
}
