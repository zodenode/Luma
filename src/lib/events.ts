import { appendAssistantMessage, mutate, upsertTreatment } from "./store";
import type { CareEvent, EventType, TreatmentState } from "./types";
import { newId } from "./id";
import { generateEventFollowup } from "./ai";
import { createEscalation, evaluateEscalationAfterEvent, symptomEscalationRecommended } from "./escalation";
import { recordAssistantEngagement, recordKpiAfterEvent } from "./kpi";

export interface IngestInput {
  userId: string;
  type: EventType;
  source: CareEvent["source"];
  payload?: Record<string, unknown>;
  /** ISO time when the event occurred (defaults to now) */
  occurredAt?: string;
  /** Stable key for deduplication (required for webhooks; optional for internal) */
  idempotencyKey?: string;
  /** When true, persist + reducer but do not run AI event follow-up (e.g. chat already replies) */
  skipFollowup?: boolean;
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
 */
export async function ingestEvent(input: IngestInput): Promise<CareEvent> {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const receivedAt = new Date().toISOString();
  const idempotencyKey =
    input.idempotencyKey ?? `internal:${input.type}:${newId()}`;

  const existing = await mutate(async (db) =>
    db.events.find((e) => e.idempotency_key === idempotencyKey),
  );
  if (existing) {
    return existing;
  }

  const event: CareEvent = {
    id: newId("evt"),
    user_id: input.userId,
    type: input.type,
    source: input.source,
    occurred_at: occurredAt,
    received_at: receivedAt,
    idempotency_key: idempotencyKey,
    payload: input.payload ?? {},
  };

  await mutate(async (db) => {
    db.events.push(event);
  });

  await applyToTreatment(event);
  await evaluateEscalationAfterEvent(event);

  if (input.type === "request_help") {
    await createEscalation({
      userId: input.userId,
      reason_code: "user_request",
      linked_event_id: event.id,
    });
    await mutate(async (db) => {
      db.events.push({
        id: newId("evt"),
        user_id: input.userId,
        type: "escalation_created",
        source: "system",
        occurred_at: receivedAt,
        received_at: receivedAt,
        idempotency_key: `${idempotencyKey}:escalation_created`,
        payload: { escalation_reason: "user_request" },
      });
    });
  }

  if (input.type === "escalation_triggered" && input.source === "user") {
    await createEscalation({
      userId: input.userId,
      reason_code: "user_request",
      linked_event_id: event.id,
    });
    await mutate(async (db) => {
      db.events.push({
        id: newId("evt"),
        user_id: input.userId,
        type: "escalation_created",
        source: "system",
        occurred_at: receivedAt,
        received_at: receivedAt,
        idempotency_key: `${idempotencyKey}:escalation_created`,
        payload: { escalation_reason: "legacy_user_escalation" },
      });
    });
  }

  if (input.type === "escalation_triggered" && input.source === "ai") {
    const reason = String((input.payload as { reason?: string })?.reason ?? "ai_flag");
    const code =
      /adherence|missed|dose/i.test(reason) ? "adherence_decline"
      : /risk|symptom|chat/i.test(reason) ? "risk_signal"
      : "non_response";
    await createEscalation({
      userId: input.userId,
      reason_code: code,
      linked_event_id: event.id,
    });
    await mutate(async (db) => {
      db.events.push({
        id: newId("evt"),
        user_id: input.userId,
        type: "escalation_created",
        source: "system",
        occurred_at: receivedAt,
        received_at: receivedAt,
        idempotency_key: `${idempotencyKey}:escalation_created_ai`,
        payload: { reason },
      });
    });
  }

  if (symptomEscalationRecommended(event)) {
    const escKey = `${idempotencyKey}:symptom_escalation`;
    const already = await mutate(async (db) => db.events.some((e) => e.idempotency_key === escKey));
    if (!already) {
      await createEscalation({
        userId: input.userId,
        reason_code: "risk_signal",
        linked_event_id: event.id,
      });
      await mutate(async (db) => {
        db.events.push({
          id: newId("evt"),
          user_id: input.userId,
          type: "escalation_created",
          source: "system",
          occurred_at: receivedAt,
          received_at: receivedAt,
          idempotency_key: escKey,
          payload: { reason: "high_severity_symptom" },
        });
      });
    }
  }

  if (!input.skipFollowup) {
    await runFollowup(event);
  }

  await recordKpiAfterEvent(event.user_id, event.type);

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
    last_interaction_at: event.occurred_at,
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
      next.medication_status = "prescribed";
      next.stage = "awaiting_fulfilment";
      next.next_recommended_action = `Pharmacy is preparing ${name}. We'll notify you on shipment.`;
      break;
    }

    case "medication_shipped":
      if (next.medication) {
        next.medication.state = "shipped";
        next.medication.shipped_at = event.occurred_at;
      }
      next.medication_status = "shipped";
      next.stage = "awaiting_fulfilment";
      next.next_recommended_action = "Your medication is on its way.";
      break;

    case "medication_delivered":
      if (next.medication) {
        next.medication.state = "delivered";
        next.medication.delivered_at = event.occurred_at;
      }
      next.medication_status = "active";
      next.stage = "active_treatment";
      next.next_recommended_action = "Start your medication and log your first dose.";
      break;

    case "adherence_confirmed":
      if (next.medication) {
        next.medication.state = "active";
        next.medication.started_at = next.medication.started_at ?? event.occurred_at;
        next.medication.last_adherence_check = event.occurred_at;
      }
      next.medication_status = "active";
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
        next.medication.next_refill_at = event.occurred_at;
      }
      next.next_recommended_action = "Confirm your refill so you don't miss doses.";
      break;

    case "user_checkin":
      next.next_recommended_action = "Your coach has new guidance below.";
      break;

    case "symptom_reported": {
      const symptom = String(event.payload.symptom ?? "");
      const sev = Number(event.payload.severity ?? 0);
      const ks = [...(next.key_symptoms ?? [])];
      if (symptom && !ks.includes(symptom)) ks.push(symptom);
      next.key_symptoms = ks.slice(-12);
      if (sev >= 8 && !next.risk_flags.includes("high_severity_symptom")) {
        next.risk_flags.push("high_severity_symptom");
      }
      break;
    }

    case "escalation_triggered":
    case "request_help": {
      next.stage = "escalated";
      if (!next.risk_flags.includes("clinician_escalation")) {
        next.risk_flags.push("clinician_escalation");
      }
      next.next_recommended_action = "A clinician will reach out. Your coach is here in the meantime.";
      break;
    }

    case "ai_followup":
    case "ai_response_generated":
    case "escalation_created":
    case "kpi_retention_window":
    case "kpi_weekly_engagement":
    case "kpi_adherence_ratio":
    case "kpi_consult_second_action":
      break;
  }

  if (typeof next.adherence_score === "number") {
    if (next.adherence_score >= 0.65) next.adherence_indicator = "good";
    else next.adherence_indicator = "at_risk";
  } else {
    next.adherence_indicator = "unknown";
  }

  return next;
}

async function runFollowup(event: CareEvent): Promise<void> {
  if (event.type === "ai_followup" || event.type === "ai_response_generated") return;

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

  await recordAssistantEngagement(event.user_id);

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
        message_id: assistant.id,
        response_type: followup.structured?.response_type,
        linked_event_id: event.id,
      },
    });
  });

  if (
    followup.escalate &&
    event.type !== "request_help" &&
    !(event.type === "escalation_triggered" && event.source === "user")
  ) {
    await ingestEvent({
      userId: event.user_id,
      type: "escalation_triggered",
      source: "ai",
      payload: { reason: followup.escalationReason ?? "AI flagged case for review" },
      idempotencyKey: `escalation:${event.id}:${followup.escalationReason ?? "ai"}`,
    });
  }
}
