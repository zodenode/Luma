export type HealthGoal = "hormones" | "weight_loss" | "energy" | "sleep" | "mental_health";

/** Clinical journey stage (UI + reducer). Aligns with plan DDL where applicable. */
export type TreatmentStage =
  | "intake"
  | "pre_consult"
  | "post_consult"
  | "awaiting_fulfilment"
  | "active_treatment"
  | "paused"
  | "escalated";

/** Plan §5A medication_status */
export type PlanMedicationStatus = "none" | "prescribed" | "shipped" | "active";

/** Plan §5A adherence_indicator */
export type AdherenceIndicator = "unknown" | "good" | "at_risk";

export type MedicationState =
  | "none"
  | "not_started"
  | "shipped"
  | "delivered"
  | "active"
  | "refill_due";

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
  /** Derived plan field for APIs / care card */
  medication_status?: PlanMedicationStatus;
  adherence_indicator?: AdherenceIndicator;
  key_symptoms?: string[];
  latest_lab_summary?: string;
  last_interaction_at?: string;
  diagnosis?: string;
  plan_summary?: string;
  next_recommended_action?: string;
  adherence_score?: number;
  risk_flags: string[];
  focus_areas?: string[];
  updated_at: string;
}

/** MVP + internal types (engineering plan §4.2) */
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
  | "ai_followup"
  | "kpi_retention_window"
  | "kpi_weekly_engagement"
  | "kpi_adherence_ratio"
  | "kpi_consult_second_action";

export type EventSource = "openloop" | "pharmacy" | "user" | "system" | "ai";

export interface CareEvent {
  id: string;
  user_id: string;
  type: EventType;
  /** @deprecated use occurred_at */
  timestamp?: string;
  occurred_at: string;
  received_at: string;
  idempotency_key: string;
  source: EventSource;
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
  metadata?: {
    response_type?: string;
    next_actions?: string[];
    adherence_risk?: "low" | "medium" | "high";
    escalation_recommended?: boolean;
    escalation_reason?: string | null;
    linked_event_ids?: string[];
    kind?: "greeting" | "event_followup" | "chat" | "nudge" | "escalation";
    eventType?: EventType;
  };
  /** @deprecated use metadata */
  meta?: {
    kind?: "greeting" | "event_followup" | "chat" | "nudge" | "escalation";
    eventType?: EventType;
  };
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

export type EscalationReasonCode = "risk_signal" | "non_response" | "adherence_decline" | "user_request";

export interface EscalationRecord {
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

export interface DB {
  users: User[];
  treatments: TreatmentState[];
  events: CareEvent[];
  messages: ChatMessage[];
  memory: ConversationMemory[];
  memory_snapshots: MemorySnapshot[];
  escalations: EscalationRecord[];
  chat_sessions: ChatSession[];
  /** KPI funnel markers (plan §9 slice E) */
  kpi_markers: KpiMarker[];
}

export interface KpiMarker {
  id: string;
  user_id: string;
  type: EventType;
  payload: Record<string, unknown>;
  created_at: string;
}
