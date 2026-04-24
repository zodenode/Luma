import {
  mutate,
  upsertTreatment,
  appendKpiEvent,
  getEvents,
  getEventsByIdempotencyKey,
  createEscalation,
} from "./store";
import type { CareEvent, EventType, TreatmentState } from "./types";
import { newId } from "./id";
import { generateEventFollowup } from "./ai";
import { appendAssistantMessage } from "./chat";
import { evaluateAdherenceEscalation, evaluateSymptomEscalation } from "./escalation";
import type { EscalationReasonCode } from "./types";

export interface IngestInput {
  userId: string;
  type: EventType;
  source: CareEvent["source"];
  payload?: Record<string, unknown>;
  occurred_at?: string;
  received_at?: string;
  idempotency_key?: string;
}

function defaultIdempotencyKey(input: IngestInput): string {
  if (input.idempotency_key) return input.idempotency_key;
  return `${input.source}:${input.type}:${input.userId}:${input.occurred_at ?? "now"}:${newId().slice(0, 8)}`;
}

/**
 * Every clinical event must produce an AI-driven follow-up in the UX (PRD).
 * ingestEvent persists the canonical envelope, updates treatment state, routes
 * side effects, and triggers coach follow-up when appropriate.
 */
export async function ingestEvent(input: IngestInput): Promise<CareEvent> {
  const occurred_at = input.occurred_at ?? new Date().toISOString();
  const received_at = input.received_at ?? new Date().toISOString();
  const idempotency_key = defaultIdempotencyKey({ ...input, occurred_at });

  const existing = await getEventsByIdempotencyKey(idempotency_key);
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

  await applyToTreatment(event);
  await routeEventActions(event);
  await runFollowup(event);

  return event;
}

async function applyToTreatment(event: CareEvent): Promise<void> {
  if (
    event.type === "ai_response_generated" ||
    event.type === "escalation_created"
  ) {
    return;
  }
  await upsertTreatment(event.user_id, (prev) => reduceTreatment(prev, event));
}

async function routeEventActions(event: CareEvent): Promise<void> {
  switch (event.type) {
    case "consult_completed":
      await appendKpiEvent(event.user_id, "consult_completed", { event_id: event.id });
      break;
    case "user_checkin":
    case "symptom_reported":
      await appendKpiEvent(event.user_id, "weekly_engagement_signal", { type: event.type });
      break;
    case "request_help":
      await appendKpiEvent(event.user_id, "request_help", { event_id: event.id });
      await createEscalation({
        userId: event.user_id,
        reason_code: "user_request",
        linkedEventId: event.id,
      });
      break;
    default:
      break;
  }

  const sym = evaluateSymptomEscalation(event);
  if (sym.shouldEscalate && sym.reason_code) {
    await maybeCreateEscalation(event.user_id, sym.reason_code, event.id, sym.detail);
  }

  if (event.type === "adherence_missed") {
    const adh = await evaluateAdherenceEscalation(event.user_id);
    if (adh.shouldEscalate && adh.reason_code) {
      await maybeCreateEscalation(event.user_id, adh.reason_code, event.id, adh.detail);
    }
  }
}

async function maybeCreateEscalation(
  userId: string,
  reason_code: EscalationReasonCode,
  linkedEventId: string,
  detail?: string,
): Promise<void> {
  await createEscalation({ userId, reason_code, linkedEventId });
  await ingestEvent({
    userId,
    type: "escalation_created",
    source: "system",
    payload: { reason_code, detail, linked_event_id: linkedEventId },
    idempotency_key: `escalation:${linkedEventId}:${reason_code}`,
  });
}

export function reduceTreatment(prev: TreatmentState, event: CareEvent): TreatmentState {
  const next: TreatmentState = {
    ...prev,
    active_medication: prev.active_medication ? { ...prev.active_medication } : null,
    key_symptoms: [...prev.key_symptoms],
  };

  const touch = () => {
    next.last_interaction_at = event.occurred_at;
  };

  switch (event.type) {
    case "intake_completed":
      next.stage = "pre_consult";
      next.next_recommended_action = "Complete your telehealth consultation.";
      touch();
      break;

    case "consult_scheduled":
      next.stage = "pre_consult";
      next.next_recommended_action = "Attend your scheduled consultation.";
      touch();
      break;

    case "consult_completed": {
      next.stage = "post_consult";
      const diagnosis = event.payload.diagnosis as string | undefined;
      const plan = event.payload.plan_summary as string | undefined;
      if (diagnosis) next.diagnosis = diagnosis;
      if (plan) next.plan_summary = plan;
      next.next_recommended_action =
        "Review your treatment plan and ask your AI coach anything.";
      touch();
      break;
    }

    case "prescription_issued": {
      const name = (event.payload.medication_name as string | undefined) ?? "your medication";
      const dosage = event.payload.dosage as string | undefined;
      next.active_medication = { name, dosage };
      next.medication_status = "prescribed";
      next.stage = "post_consult";
      next.next_recommended_action = `Pharmacy is preparing ${name}. We'll notify you on shipment.`;
      touch();
      break;
    }

    case "medication_shipped":
      if (next.active_medication) next.medication_status = "shipped";
      next.next_recommended_action =
        "Your medication is on the way — plan when you'll start and log your first dose.";
      touch();
      break;

    case "medication_delivered":
      if (next.active_medication) next.medication_status = "active";
      next.stage = "active_treatment";
      next.next_recommended_action = "Start your medication and log your first dose.";
      touch();
      break;

    case "user_checkin": {
      const preview = event.payload.message_preview as string | undefined;
      const isAdherenceLog = Boolean(event.payload.adherence_log);
      if (isAdherenceLog) {
        next.stage = "active_treatment";
        if (next.medication_status === "shipped" || next.medication_status === "prescribed") {
          next.medication_status = "active";
        }
        const prevScore = next.adherence_score ?? 0.65;
        next.adherence_score = Math.min(1, prevScore + 0.08);
      } else if (preview && preview.length > 0) {
        const prevScore = next.adherence_score ?? 0.65;
        next.adherence_score = Math.min(1, prevScore + 0.02);
      }
      next.adherence_indicator =
        next.adherence_score == null
          ? "unknown"
          : next.adherence_score >= 0.55
            ? "good"
            : "at_risk";
      next.next_recommended_action = "Your coach has new guidance below.";
      touch();
      break;
    }

    case "symptom_reported": {
      const symptom = (event.payload.symptom as string | undefined) ?? "symptom";
      if (!next.key_symptoms.includes(symptom)) next.key_symptoms.push(symptom);
      touch();
      break;
    }

    case "adherence_missed": {
      const prevScore = next.adherence_score ?? 0.7;
      next.adherence_score = Math.max(0, prevScore - 0.15);
      next.adherence_indicator = next.adherence_score >= 0.55 ? "good" : "at_risk";
      next.next_recommended_action =
        "Log your most recent dose, or tell the coach what got in the way.";
      touch();
      break;
    }

    case "refill_due":
      next.next_recommended_action = "Confirm your refill so you don't miss doses.";
      touch();
      break;

    case "request_help":
      next.next_recommended_action = "A clinician will follow up. Your coach is here meanwhile.";
      touch();
      break;

    case "escalation_created":
      touch();
      break;

    case "ai_response_generated":
      break;
  }

  return next;
}

async function runFollowup(event: CareEvent): Promise<void> {
  if (event.type === "ai_response_generated" || event.type === "escalation_created") return;

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

  await mutate(async (db) => {
    db.events.push({
      id: newId("evt"),
      user_id: event.user_id,
      type: "ai_response_generated",
      source: "ai",
      occurred_at: new Date().toISOString(),
      received_at: new Date().toISOString(),
      idempotency_key: `ai_response:${assistant.id}`,
      payload: {
        response_type: followup.structured?.response_type,
        message_id: assistant.id,
        linked_event_id: event.id,
      },
    });
  });

  if (followup.escalate) {
    await createEscalation({
      userId: event.user_id,
      reason_code: "risk_signal",
      linkedEventId: event.id,
    });
    await ingestEvent({
      userId: event.user_id,
      type: "escalation_created",
      source: "ai",
      payload: { reason: followup.escalationReason ?? "AI flagged case for review" },
      idempotency_key: `escalation_ai:${event.id}`,
    });
  }

  await maybeMarkConsultToSecondAction(event.user_id, event.type);
}

async function maybeMarkConsultToSecondAction(userId: string, type: EventType): Promise<void> {
  const meaningful: EventType[] = [
    "user_checkin",
    "symptom_reported",
    "medication_shipped",
    "medication_delivered",
    "prescription_issued",
  ];
  if (!meaningful.includes(type)) return;

  const { readDB } = await import("./store");
  const db = await readDB();
  if (db.kpi_events.some((k) => k.user_id === userId && k.name === "consult_to_second_action")) return;

  const evs = await getEvents(userId);
  const consult = evs.find((e) => e.type === "consult_completed");
  if (!consult) return;
  const t0 = consult.occurred_at;
  const afterConsult = evs.filter(
    (e) => e.occurred_at > t0 && meaningful.includes(e.type),
  );
  if (afterConsult.length >= 2) {
    await appendKpiEvent(userId, "consult_to_second_action", { trigger: type });
  }
}
