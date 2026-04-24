/** Health goal at intake (display + routing). */
export type HealthGoal = "hormones" | "weight_loss" | "energy" | "sleep" | "mental_health";

/** Canonical treatment stage (engineering plan §5). */
export type TreatmentStage = "pre_consult" | "post_consult" | "active_treatment";

/** Canonical medication fulfillment status. */
export type MedicationStatus = "none" | "prescribed" | "shipped" | "active";

/** Adherence indicator for UI + AI context. */
export type AdherenceIndicator = "unknown" | "good" | "at_risk";

export type ChatRole = "user" | "assistant" | "system";

/** MVP + product onboarding / pharmacy lifecycle extensions. */
export type EventType =
  | "intake_completed"
  | "consult_scheduled"
  | "consult_completed"
  | "prescription_issued"
  | "medication_shipped"
  | "medication_delivered"
  | "user_checkin"
  | "symptom_reported"
  | "adherence_missed"
  | "request_help"
  | "ai_response_generated"
  | "escalation_created"
  | "refill_due";

export type EventSource = "openloop" | "pharmacy" | "user" | "system" | "ai";

export interface User {
  id: string;
  name: string;
  goal: HealthGoal;
  symptoms: string[];
  history: string;
  linked_openloop_id?: string;
  created_at: string;
  updated_at: string;
}

/** Materialized care state (maps to `treatment_states` in Postgres DDL). */
export interface TreatmentState {
  user_id: string;
  stage: TreatmentStage;
  active_medication: { name: string; dosage?: string } | null;
  medication_status: MedicationStatus;
  adherence_indicator: AdherenceIndicator;
  adherence_score: number | null;
  key_symptoms: string[];
  latest_lab_summary: string | null;
  next_recommended_action: string | null;
  last_interaction_at: string | null;
  /** Clinician-provided context after consult (not PHI-minimized in MVP store). */
  diagnosis?: string;
  plan_summary?: string;
  updated_at: string;
}

/** Canonical event envelope (engineering plan §4.1). */
export interface CareEvent {
  id: string;
  user_id: string;
  type: EventType;
  source: EventSource;
  occurred_at: string;
  received_at: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  /** @deprecated Legacy field; prefer occurred_at */
  timestamp?: string;
}

export interface ChatMessage {
  id: string;
  user_id: string;
  role: ChatRole;
  content: string;
  created_at: string;
  metadata: Record<string, unknown>;
  /** @deprecated Use metadata */
  event_id?: string;
  meta?: {
    kind?: "greeting" | "event_followup" | "chat" | "nudge" | "escalation";
    eventType?: EventType;
  };
}

export interface ConversationMemory {
  user_id: string;
  summary: string;
  open_threads: string[];
  last_summarized_message_id: string | null;
  updated_at: string;
}

export interface MemorySnapshot {
  id: string;
  user_id: string;
  summary: string;
  open_threads: string[];
  source_message_from_id: string | null;
  source_message_to_id: string | null;
  created_at: string;
}

export type EscalationReasonCode = "risk_signal" | "non_response" | "adherence_decline" | "user_request";

export type EscalationStatus = "open" | "acknowledged" | "closed";

export interface Escalation {
  id: string;
  user_id: string;
  reason_code: EscalationReasonCode;
  status: EscalationStatus;
  linked_event_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatSession {
  id: string;
  user_id: string;
  rehydrated_snapshot_id: string | null;
  started_at: string;
  last_seen_at: string;
}

/** Lightweight KPI / funnel markers (engineering plan §10). */
export interface KpiEvent {
  id: string;
  user_id: string;
  name: string;
  occurred_at: string;
  payload: Record<string, unknown>;
}

/** Structured LLM output (engineering plan §7.1). */
export interface StructuredCoachResponse {
  response_type: string;
  message: string;
  next_actions: string[];
  adherence_risk: "low" | "medium" | "high";
  escalation_recommended: boolean;
  escalation_reason: string | null;
}

export interface DB {
  schema_version: number;
  users: User[];
  treatments: TreatmentState[];
  events: CareEvent[];
  messages: ChatMessage[];
  memory: ConversationMemory[];
  memory_snapshots: MemorySnapshot[];
  escalations: Escalation[];
  chat_sessions: ChatSession[];
  kpi_events: KpiEvent[];
}
