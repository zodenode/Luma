export type HealthGoal = "hormones" | "weight_loss" | "energy" | "sleep" | "mental_health";

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

export interface User {
  id: string;
  name: string;
  goal: HealthGoal;
  symptoms: string[];
  history: string;
  linked_openloop_id?: string;
  created_at: string;
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
  adherence_score?: number; // 0..1
  risk_flags: string[];
  updated_at: string;
}

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
  | "escalation_triggered"
  | "ai_followup";

export interface CareEvent {
  id: string;
  user_id: string;
  type: EventType;
  timestamp: string;
  source: "user" | "openloop" | "pharmacy" | "system" | "ai";
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
  };
}

export interface ConversationMemory {
  user_id: string;
  summary: string;
  updated_at: string;
}

export interface DB {
  users: User[];
  treatments: TreatmentState[];
  events: CareEvent[];
  messages: ChatMessage[];
  memory: ConversationMemory[];
}
