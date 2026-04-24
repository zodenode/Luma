import { mutate, upsertTreatment } from "./store";
import type { CareEvent, EventType, TreatmentState } from "./types";
import { newId } from "./id";
import { generateEventFollowup } from "./ai";
import { appendAssistantMessage } from "./chat";

export interface IngestInput {
  userId: string;
  type: EventType;
  source: CareEvent["source"];
  payload?: Record<string, unknown>;
  timestamp?: string;
}

/**
 * Core product principle:
 *   "Every clinical event must produce an AI-driven follow-up action
 *    within the user experience."
 *
 * ingestEvent() is the single entry point used by:
 *   - user actions (intake, check-in, symptom report)
 *   - OpenLoop webhooks (consult_completed, prescription_issued)
 *   - pharmacy webhooks (medication_shipped, medication_delivered, refill_due)
 *   - internal schedulers (adherence_missed)
 *
 * It does three things, in order:
 *   1. persists the event in the event log
 *   2. updates the TreatmentState via a reducer
 *   3. triggers an AI follow-up (chat message, nudge, or escalation)
 */
export async function ingestEvent(input: IngestInput): Promise<CareEvent> {
  const event: CareEvent = {
    id: newId("evt"),
    user_id: input.userId,
    type: input.type,
    source: input.source,
    payload: input.payload ?? {},
    timestamp: input.timestamp ?? new Date().toISOString(),
  };

  await mutate(async (db) => {
    db.events.push(event);
  });

  await applyToTreatment(event);
  await runFollowup(event);

  return event;
}

async function applyToTreatment(event: CareEvent): Promise<void> {
  await upsertTreatment(event.user_id, (prev) => reduceTreatment(prev, event));
}

export function reduceTreatment(prev: TreatmentState, event: CareEvent): TreatmentState {
  const next: TreatmentState = {
    ...prev,
    medication: prev.medication ? { ...prev.medication } : undefined,
    risk_flags: [...prev.risk_flags],
  };

  switch (event.type) {
    case "intake_completed":
      next.stage = "pre_consult";
      next.next_recommended_action = "Complete your telehealth consultation.";
      break;

    case "consult_scheduled":
      next.stage = "pre_consult";
      next.next_recommended_action = "Attend your scheduled consultation.";
      break;

    case "consult_completed": {
      next.stage = "post_consult";
      const diagnosis = event.payload.diagnosis as string | undefined;
      const plan = event.payload.plan_summary as string | undefined;
      if (diagnosis) next.diagnosis = diagnosis;
      if (plan) next.plan_summary = plan;
      next.next_recommended_action = "Review your treatment plan and ask your AI coach anything.";
      break;
    }

    case "prescription_issued": {
      const name = (event.payload.medication_name as string | undefined) ?? "your medication";
      const dosage = event.payload.dosage as string | undefined;
      next.medication = {
        ...(next.medication ?? { state: "not_started", name: "" }),
        name,
        dosage,
        state: "not_started",
      };
      next.stage = "awaiting_fulfilment";
      next.next_recommended_action = `Pharmacy is preparing ${name}. We'll notify you on shipment.`;
      break;
    }

    case "medication_shipped":
      if (next.medication) {
        next.medication.state = "shipped";
        next.medication.shipped_at = event.timestamp;
      }
      next.stage = "awaiting_fulfilment";
      next.next_recommended_action = "Your medication is on its way.";
      break;

    case "medication_delivered":
      if (next.medication) {
        next.medication.state = "delivered";
        next.medication.delivered_at = event.timestamp;
      }
      next.stage = "active_treatment";
      next.next_recommended_action = "Start your medication and log your first dose.";
      break;

    case "adherence_confirmed":
      if (next.medication) {
        next.medication.state = "active";
        next.medication.started_at = next.medication.started_at ?? event.timestamp;
        next.medication.last_adherence_check = event.timestamp;
      }
      next.stage = "active_treatment";
      next.adherence_score = Math.min(1, (prev.adherence_score ?? 0.6) + 0.1);
      next.next_recommended_action = "Keep going. Check in tomorrow with how you're feeling.";
      break;

    case "adherence_missed":
      next.adherence_score = Math.max(0, (prev.adherence_score ?? 0.7) - 0.15);
      next.next_recommended_action = "Log your most recent dose, or tell the coach what got in the way.";
      if ((next.adherence_score ?? 0) < 0.3 && !next.risk_flags.includes("low_adherence")) {
        next.risk_flags.push("low_adherence");
      }
      break;

    case "refill_due":
      if (next.medication) {
        next.medication.state = "refill_due";
        next.medication.next_refill_at = event.timestamp;
      }
      next.next_recommended_action = "Confirm your refill so you don't miss doses.";
      break;

    case "user_checkin":
      next.next_recommended_action = "Your coach has new guidance below.";
      break;

    case "symptom_reported": {
      const severity = Number(event.payload.severity ?? 0);
      if (severity >= 8 && !next.risk_flags.includes("high_severity_symptom")) {
        next.risk_flags.push("high_severity_symptom");
      }
      break;
    }

    case "escalation_triggered":
      next.stage = "escalated";
      if (!next.risk_flags.includes("clinician_escalation")) {
        next.risk_flags.push("clinician_escalation");
      }
      next.next_recommended_action = "A clinician will reach out. Your coach is here in the meantime.";
      break;

    case "ai_followup":
      break;
  }

  return next;
}

async function runFollowup(event: CareEvent): Promise<void> {
  if (event.type === "ai_followup") return;

  const followup = await generateEventFollowup(event);
  if (!followup) return;

  await appendAssistantMessage({
    userId: event.user_id,
    content: followup.message,
    eventId: event.id,
    kind: followup.kind,
    eventType: event.type,
  });

  if (followup.escalate) {
    await ingestEvent({
      userId: event.user_id,
      type: "escalation_triggered",
      source: "ai",
      payload: { reason: followup.escalationReason ?? "AI flagged case for review" },
    });
  }
}
