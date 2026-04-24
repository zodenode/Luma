import clsx from "clsx";
import type { CareEvent, EventType } from "@/lib/types";

const EVENT_LABEL: Record<EventType, string> = {
  intake_completed: "Intake completed",
  consult_scheduled: "Consult scheduled",
  consult_completed: "Consult completed",
  prescription_issued: "Prescription issued",
  medication_shipped: "Medication shipped",
  medication_delivered: "Medication delivered",
  user_checkin: "Check-in",
  symptom_reported: "Symptom reported",
  adherence_missed: "Dose missed",
  adherence_confirmed: "Dose logged",
  refill_due: "Refill due",
  request_help: "Help requested",
  ai_response_generated: "Coach update",
  escalation_created: "Escalation queued",
  escalation_triggered: "Escalation",
  ai_followup: "AI follow-up",
};

const DOT: Record<EventType, string> = {
  intake_completed: "bg-luma-muted",
  consult_scheduled: "bg-luma-accent2",
  consult_completed: "bg-luma-accent2",
  prescription_issued: "bg-luma-accent",
  medication_shipped: "bg-luma-accent",
  medication_delivered: "bg-luma-accent",
  user_checkin: "bg-luma-muted",
  symptom_reported: "bg-luma-warn",
  adherence_missed: "bg-luma-warn",
  adherence_confirmed: "bg-luma-accent",
  refill_due: "bg-luma-warn",
  request_help: "bg-luma-danger",
  ai_response_generated: "bg-luma-muted",
  escalation_created: "bg-luma-warn",
  escalation_triggered: "bg-luma-danger",
  ai_followup: "bg-luma-muted",
};

const HIDE_TYPES = new Set<EventType>(["user_checkin", "ai_response_generated"]);

export default function CareTimeline({ events }: { events: CareEvent[] }) {
  const visible = events.filter((e) => !HIDE_TYPES.has(e.type)).slice(0, 12);

  return (
    <div className="card p-4">
      <div className="text-xs uppercase tracking-wide text-luma-muted">Timeline</div>
      {visible.length === 0 ? (
        <div className="text-sm text-luma-muted mt-3">No events yet.</div>
      ) : (
        <ol className="mt-3 relative border-l border-luma-border pl-4 space-y-3">
          {visible.map((e) => (
            <li key={e.id} className="relative">
              <span
                className={clsx(
                  "absolute -left-[21px] top-1.5 w-2.5 h-2.5 rounded-full border-2 border-luma-panel",
                  DOT[e.type],
                )}
              />
              <div className="text-sm">{EVENT_LABEL[e.type]}</div>
              <div className="text-[11px] text-luma-muted">
                {formatTime(e.occurred_at)} · {e.source}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
