export type HealthGoal = "hormones" | "weight_loss" | "energy" | "sleep" | "mental_health";

/** Aligns with logical model + Postgres enum subset used in MVP UI */
export type TreatmentStage =
  | "intake"
  | "pre_consult"
  | "post_consult"
  | "awaiting_fulfilment"
  | "active_treatment"
  | "paused"
  | "escalated";

export type MedicationState =
  | "none"
  | "not_started"
  | "shipped"
  | "delivered"
  | "active"
  | "refill_due";

export type AdherenceIndicator = "unknown" | "good" | "at_risk";

export interface User {
  id: string;
  name: string;
  goal: HealthGoal;
  symptoms: string[];
  history: string;
  linked_openloop_id?: string;
  created_at: string;
  updated_at?: string;
}

export interface TreatmentState {
  user_id: string;
  stage: TreatmentStage;
  medication?: {
    name: string;
    dosage?: string;
    state: MedicationState;
    shipped_at?: string;
    delivered_at?: string;
    started_at?: string;
    next_refill_at?: string;
    last_adherence_check?: string;
  };
  diagnosis?: string;
  plan_summary?: string;
  next_recommended_action?: string;
  adherence_score?: number;
  adherence_indicator?: AdherenceIndicator;
  key_symptoms?: string[];
  latest_lab_summary?: string;
  last_interaction_at?: string;
  risk_flags: string[];
  updated_at: string;
}

export type EventSource = "user" | "openloop" | "pharmacy" | "system" | "ai";

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
  | "adherence_confirmed"
  | "refill_due"
  | "request_help"
  | "ai_response_generated"
  | "escalation_created"
  | "escalation_triggered"
  | "ai_followup";

export interface CareEvent {
  id: string;
  user_id: string;
  type: EventType;
  /** @deprecated use occurred_at */
  timestamp?: string;
  occurred_at: string;
  received_at: string;
  source: EventSource;
  idempotency_key: string;
  payload: Record<string, unknown>;
  ai_followup_id?: string;
}

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  user_id: string;
  role: ChatRole;
  content: string;
  created_at: string;
  event_id?: string;
  meta?: {
    kind?: "greeting" | "event_followup" | "chat" | "nudge" | "escalation";
    eventType?: EventType;
    channel?: "chat" | "action";
    response_type?: string;
    next_actions?: string[];
    adherence_risk?: "low" | "medium" | "high";
    escalation_recommended?: boolean;
    escalation_reason?: string | null;
  };
}

export interface StructuredCoachResponse {
  response_type: string;
  message: string;
  next_actions: string[];
  adherence_risk: "low" | "medium" | "high";
  escalation_recommended: boolean;
  escalation_reason: string | null;
}

export interface ConversationMemory {
  user_id: string;
  summary: string;
  open_threads: string[];
  last_summarized_message_id?: string;
  updated_at: string;
}

export interface MemorySnapshot {
  id: string;
  user_id: string;
  summary: string;
  open_threads: string[];
  source_message_from_id?: string;
  source_message_to_id?: string;
  created_at: string;
}

export type EscalationReasonCode = "risk_signal" | "non_response" | "adherence_decline" | "user_request" | "other";

export interface Escalation {
  id: string;
  user_id: string;
  reason_code: EscalationReasonCode;
  status: "open" | "acknowledged" | "closed";
  linked_event_id?: string;
  created_at: string;
  updated_at: string;
}

export interface ChatSession {
  id: string;
  user_id: string;
  rehydrated_snapshot_id?: string;
  started_at: string;
  last_seen_at: string;
}

export type KPIEventType =
  | "user_retention_window"
  | "adherence_expected_day"
  | "adherence_logged_day"
  | "weekly_ai_engagement"
  | "consult_second_action";

export interface KPIEvent {
  id: string;
  user_id: string;
  type: KPIEventType;
  payload: Record<string, unknown>;
  created_at: string;
}

export type AuditAction =
  | "event_ingested"
  | "webhook_received"
  | "escalation_created"
  | "chat_message"
  | "memory_summarized";

export interface AuditLogEntry {
  id: string;
  action: AuditAction;
  user_id?: string;
  resource_type?: string;
  resource_id?: string;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface DB {
  users: User[];
  treatments: TreatmentState[];
  events: CareEvent[];
  messages: ChatMessage[];
  memory: ConversationMemory[];
  memory_snapshots: MemorySnapshot[];
  escalations: Escalation[];
  chat_sessions: ChatSession[];
  kpi_events: KPIEvent[];
  audit_log: AuditLogEntry[];
}
