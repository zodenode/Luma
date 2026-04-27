import { emitConsultSecondActionIfNeeded, emitRetentionCohortMarkers } from "./kpi";
import {
  appendAuditLog,
  appendKPIEvent,
  createEscalation,
  findEventByIdempotencyKey,
  getEvents,
  mutate,
  upsertTreatment,
} from "./store";
import type { CareEvent, EventSource, EventType, TreatmentState } from "./types";
import { newId } from "./id";
import { generateEventFollowup } from "./ai";
import { appendAssistantMessage } from "./chat";
import { classifySymptomEscalation, mapRequestHelpReason, shouldEscalateAdherenceMisses } from "./escalation";

export interface IngestInput {
  userId: string;
  type: EventType;
  source: EventSource;
  payload?: Record<string, unknown>;
  occurred_at?: string;
  idempotency_key?: string;
}

function defaultIdempotencyKey(input: IngestInput): string {
  if (input.idempotency_key) return input.idempotency_key;
  return `${input.source}:${input.type}:${newId("idem")}`;
}

/**
 * Every clinical event must produce an AI-driven follow-up in the UX.
 * ingestEvent persists, updates treatment state, runs routing, and triggers follow-up.
 */
export async function ingestEvent(input: IngestInput): Promise<CareEvent> {
  const occurred_at = input.occurred_at ?? new Date().toISOString();
  const received_at = new Date().toISOString();
  const idempotency_key = defaultIdempotencyKey(input);

  const existing = await findEventByIdempotencyKey(idempotency_key);
  if (existing) return existing;

  const event: CareEvent = {
    id: newId("evt"),
    user_id: input.userId,
    type: input.type,
    source: input.source,
    occurred_at,
    received_at,
    idempotency_key,
    payload: input.payload ?? {},
  };

  await mutate(async (db) => {
    db.events.push(event);
  });

  await appendAuditLog({
    action: "event_ingested",
    user_id: input.userId,
    resource_type: "event",
    resource_id: event.id,
    detail: { type: event.type, source: event.source, idempotency_key },
  });

  await applyToTreatment(event);
  await routeEventActions(event);
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
    key_symptoms: [...(prev.key_symptoms ?? [])],
    last_interaction_at: event.occurred_at,
  };

  const setAdherenceFromScore = (score: number | undefined) => {
    if (score == null) next.adherence_indicator = "unknown";
    else if (score >= 0.65) next.adherence_indicator = "good";
    else next.adherence_indicator = "at_risk";
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
        next.medication.shipped_at = event.occurred_at;
      }
      next.stage = "awaiting_fulfilment";
      next.next_recommended_action = "Your medication is on the way.";
      break;

    case "medication_delivered":
      if (next.medication) {
        next.medication.state = "delivered";
        next.medication.delivered_at = event.occurred_at;
      }
      next.stage = "active_treatment";
      next.next_recommended_action = "Start your medication and log your first dose.";
      break;

    case "adherence_confirmed":
      if (next.medication) {
        next.medication.state = "active";
        next.medication.started_at = next.medication.started_at ?? event.occurred_at;
        next.medication.last_adherence_check = event.occurred_at;
      }
      next.stage = "active_treatment";
      next.adherence_score = Math.min(1, (prev.adherence_score ?? 0.6) + 0.1);
      setAdherenceFromScore(next.adherence_score);
      next.next_recommended_action = "Keep going. Check in tomorrow with how you're feeling.";
      break;

    case "adherence_missed":
      next.adherence_score = Math.max(0, (prev.adherence_score ?? 0.7) - 0.15);
      setAdherenceFromScore(next.adherence_score);
      next.next_recommended_action = "Log your most recent dose, or tell the coach what got in the way.";
      if ((next.adherence_score ?? 0) < 0.3 && !next.risk_flags.includes("low_adherence")) {
        next.risk_flags.push("low_adherence");
      }
      break;

    case "refill_due":
      if (next.medication) {
        next.medication.state = "refill_due";
        next.medication.next_refill_at = event.occurred_at;
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
      const symptom = String(event.payload.symptom ?? "").trim();
      if (symptom && !(next.key_symptoms ?? []).includes(symptom)) {
        next.key_symptoms = [...(next.key_symptoms ?? []), symptom].slice(-20);
      }
      break;
    }

    case "request_help":
      next.stage = "escalated";
      if (!next.risk_flags.includes("user_requested_help")) {
        next.risk_flags.push("user_requested_help");
      }
      next.next_recommended_action = "A clinician will review your request shortly.";
      break;

    case "escalation_triggered":
      next.stage = "escalated";
      if (!next.risk_flags.includes("clinician_escalation")) {
        next.risk_flags.push("clinician_escalation");
      }
      next.next_recommended_action = "A clinician will reach out. Your coach is here in the meantime.";
      break;

    case "escalation_created":
    case "ai_response_generated":
    case "ai_followup":
      break;
  }

  return next;
}

async function routeEventActions(event: CareEvent): Promise<void> {
  await maybeEmitKPI(event);

  if (event.type === "symptom_reported") {
    const { escalate } = classifySymptomEscalation(event.payload);
    if (escalate) {
      await createEscalationRecord(event, "risk_signal");
    }
  }

  if (event.type === "adherence_missed") {
    const recent = await getEventsForUser(event.user_id);
    if (shouldEscalateAdherenceMisses(recent)) {
      await createEscalationRecord(event, "adherence_decline");
    }
  }

  if (event.type === "request_help") {
    await createEscalationRecord(event, mapRequestHelpReason(event.payload));
  }
}

async function getEventsForUser(userId: string): Promise<CareEvent[]> {
  return getEvents(userId);
}

async function maybeEmitKPI(event: CareEvent): Promise<void> {
  if (event.type === "consult_completed") {
    await emitRetentionCohortMarkers(event.user_id, event);
  }

  if (event.type === "adherence_confirmed") {
    await appendKPIEvent(event.user_id, "adherence_logged_day", {
      event_id: event.id,
      occurred_at: event.occurred_at,
    });
    await appendKPIEvent(event.user_id, "adherence_expected_day", {
      event_id: event.id,
      occurred_at: event.occurred_at,
      numerator: true,
    });
  }

  if (event.type === "adherence_missed") {
    await appendKPIEvent(event.user_id, "adherence_expected_day", {
      event_id: event.id,
      occurred_at: event.occurred_at,
      numerator: false,
    });
  }

  if (event.type === "user_checkin") {
    const ch = (event.payload as { channel?: string }).channel;
    if (ch !== "chat") {
      await appendKPIEvent(event.user_id, "weekly_ai_engagement", {
        event_id: event.id,
        channel: ch ?? "unknown",
      });
    }
  }

  if (
    event.type === "adherence_confirmed" ||
    event.type === "symptom_reported" ||
    (event.type === "user_checkin" && (event.payload as { channel?: string }).channel !== "chat") ||
    event.type === "request_help"
  ) {
    await emitConsultSecondActionIfNeeded(event.user_id, event);
  }
}

async function createEscalationRecord(
  event: CareEvent,
  reason: import("./types").EscalationReasonCode,
): Promise<void> {
  const esc = await createEscalation({
    userId: event.user_id,
    reasonCode: reason,
    linkedEventId: event.id,
  });
  await appendAuditLog({
    action: "escalation_created",
    user_id: event.user_id,
    resource_type: "escalation",
    resource_id: esc.id,
    detail: { reason_code: reason, linked_event_id: event.id },
  });
  await ingestEvent({
    userId: event.user_id,
    type: "escalation_created",
    source: "system",
    payload: { escalation_id: esc.id, reason_code: reason, linked_event_id: event.id },
    idempotency_key: `escalation_created:${esc.id}`,
  });
}

async function runFollowup(event: CareEvent): Promise<void> {
  if (event.type === "ai_followup" || event.type === "ai_response_generated") return;
  if (event.type === "escalation_created") return;

  if (event.type === "user_checkin" && (event.payload as { channel?: string }).channel === "chat") {
    return;
  }

  const followup = await generateEventFollowup(event);
  if (!followup) return;

  const assistant = await appendAssistantMessage({
    userId: event.user_id,
    content: followup.message,
    eventId: event.id,
    kind: followup.kind,
    eventType: event.type,
    structured: followup.structured,
  });

  await ingestEvent({
    userId: event.user_id,
    type: "ai_response_generated",
    source: "ai",
    payload: {
      assistant_message_id: assistant.id,
      response_type: followup.structured?.response_type,
      linked_event_id: event.id,
    },
    idempotency_key: `ai_response:${assistant.id}`,
  });

  if (followup.escalate) {
    await ingestEvent({
      userId: event.user_id,
      type: "escalation_triggered",
      source: "ai",
      payload: { reason: followup.escalationReason ?? "AI flagged case for review" },
      idempotency_key: `ai_escalation:${event.id}:${assistant.id}`,
    });
  }
}
