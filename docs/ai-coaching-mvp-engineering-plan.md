# AI Coaching MVP (OpenLoop Wrapper) — Engineering Build Plan

## 1) Purpose

This document translates the PRD into an implementation-ready MVP plan with concrete service boundaries, API/event contracts, data structures, and delivery phases.

Primary product principle:

> Every clinical event must produce an AI-driven follow-up action inside the user experience.

---

## 2) MVP scope and assumptions

### In scope

- Web chat interface for AI coaching
- Care status sidebar + lightweight timeline
- Quick actions (`check_in`, `log_medication`, `ask_question`, `request_help`)
- Webhook ingestion from OpenLoop and pharmacy
- Event-driven orchestration for responses, reminders, and escalation
- Basic clinician escalation queue

### Out of scope

- EHR replacement
- Wearables / RPM ingest
- Advanced analytics warehouse and BI dashboards
- Multi-provider orchestration beyond OpenLoop + one pharmacy connector

### Assumptions

- OpenLoop emits identifiable patient and consultation events
- Pharmacy integration can provide shipment lifecycle updates
- AI model access is available via an LLM API with JSON-structured outputs

---

## 3) Reference architecture (MVP)

### 3.1 Frontend (web)

- `ChatView`: conversation thread + composer
- `CareStatusPanel`: treatment stage, medication status, next action, adherence indicator
- `CareTimeline`: ordered event history
- `QuickActionsBar`: one-tap inputs that map to event creation

### 3.2 Backend services (thin orchestration)

1. **API Gateway / BFF**
   - Authenticated user endpoints for chat, timeline, and actions

2. **Event Ingestion Service**
   - Accepts internal and external events
   - Validates and normalizes to canonical schema
   - Persists to event log and publishes to processing queue

3. **Webhook Handlers**
   - `POST /webhooks/openloop`
   - `POST /webhooks/pharmacy`
   - Signature verification + idempotent processing

4. **AI Response Service**
   - Builds coaching context from treatment state + conversation memory + recent events
   - Requests structured response from LLM
   - Stores generated message and emits `ai_response_generated`

5. **User State Store**
   - Materialized state for low-latency UI rendering
   - Derived from events (stage, medication status, adherence score, next action)

6. **Escalation Service**
   - Rule-based risk/non-response detection
   - Creates escalation records for clinician/coach queue

---

## 4) Canonical event model

### 4.1 Event envelope

```json
{
  "id": "evt_01J...",
  "user_id": "usr_123",
  "type": "consult_completed",
  "source": "openloop",
  "occurred_at": "2026-04-24T12:00:00Z",
  "received_at": "2026-04-24T12:00:02Z",
  "idempotency_key": "openloop:consult:abc123",
  "payload": {}
}
```

Required fields:

- `id` (internal unique id)
- `user_id`
- `type` (enum)
- `source` (`openloop`, `pharmacy`, `user`, `system`, `ai`)
- `occurred_at`, `received_at`
- `idempotency_key`
- `payload` (type-specific)

### 4.2 MVP event types

- `consult_completed`
- `prescription_issued`
- `medication_shipped`
- `user_checkin`
- `symptom_reported`
- `adherence_missed`
- `request_help`
- `ai_response_generated` (internal)
- `escalation_created` (internal)

### 4.3 Event-to-action routing matrix

| Event type | Default action | Secondary action |
|---|---|---|
| consult_completed | AI explains treatment plan | Set stage to `post_consult` |
| prescription_issued | AI explains medication and expectations | Start adherence monitoring |
| medication_shipped | Send "start when arrives" guidance | Set medication status `shipped` |
| user_checkin | AI feedback on check-in | Update adherence indicator |
| symptom_reported | AI symptom interpretation (non-diagnostic) | Evaluate escalation rules |
| adherence_missed | Nudge + practical restart plan | Escalate if repeated |
| request_help | Immediate supportive response | Create escalation for human follow-up |

---

## 5) Data model (logical)

### 5.1 `users`

- `id` (pk)
- `linked_openloop_id` (unique nullable)
- `goal`
- `created_at`, `updated_at`

### 5.2 `treatment_states`

- `user_id` (pk, fk users.id)
- `stage` (`pre_consult`, `post_consult`, `active_treatment`)
- `active_medication` (nullable text/json)
- `medication_status` (`none`, `prescribed`, `shipped`, `active`)
- `adherence_indicator` (`unknown`, `good`, `at_risk`)
- `next_recommended_action`
- `updated_at`

### 5.3 `events`

- `id` (pk)
- `user_id` (indexed)
- `type` (indexed)
- `source`
- `occurred_at` (indexed)
- `received_at`
- `idempotency_key` (unique)
- `payload` (jsonb)

### 5.4 `messages`

- `id` (pk)
- `user_id` (indexed)
- `role` (`user`, `assistant`, `system`)
- `content`
- `metadata` (jsonb; includes response type, linked event ids)
- `created_at`

### 5.5 `conversation_memory`

- `user_id` (pk)
- `summary`
- `last_summarized_message_id`
- `updated_at`

### 5.6 `escalations`

- `id` (pk)
- `user_id` (indexed)
- `reason_code` (`risk_signal`, `non_response`, `adherence_decline`)
- `status` (`open`, `acknowledged`, `closed`)
- `linked_event_id`
- `created_at`, `updated_at`

---

## 6) API contract (MVP)

### 6.1 User-facing endpoints

- `GET /v1/care/state`
  - Returns stage, medication status, adherence indicator, next action
- `GET /v1/care/timeline?cursor=...`
  - Returns canonical events for timeline display
- `POST /v1/chat/messages`
  - Accepts user message and returns assistant message
- `POST /v1/actions/checkin`
  - Creates `user_checkin`
- `POST /v1/actions/log-medication`
  - Creates adherence-related event
- `POST /v1/actions/request-help`
  - Creates `request_help` + immediate escalation review

### 6.2 Integration endpoints

- `POST /v1/webhooks/openloop`
- `POST /v1/webhooks/pharmacy`

Webhook requirements:

- HMAC signature validation
- Idempotency key extraction
- 2xx fast acknowledgment pattern after durable enqueue

---

## 7) AI response pipeline

1. Trigger received (event or user message)
2. Build context packet:
   - Current treatment state
   - Recent events (time window + key markers)
   - Conversation memory summary
   - Safety / policy constraints
3. Call LLM with structured output schema
4. Validate output schema
5. Persist assistant message
6. Update memory and derived state
7. Run escalation classifier/rules

Structured AI response shape:

```json
{
  "response_type": "daily_guidance",
  "message": "string",
  "next_actions": ["string"],
  "adherence_risk": "low|medium|high",
  "escalation_recommended": false,
  "escalation_reason": null
}
```

---

## 8) Escalation rules (MVP)

Create escalation when any of the following are true:

- High-risk symptom keywords + confidence threshold crossed
- `adherence_missed` occurs N times in rolling window
- No user response to critical prompts within threshold window
- User explicitly requests human help

Rule engine can be simple deterministic logic in MVP; keep interfaces pluggable for future ML risk models.

---

## 9) Delivery plan by implementation slices

### Slice A — Foundation

- Data tables + migration
- Event ingestion pipeline + canonical schema
- OpenLoop/pharmacy webhook skeleton with signature checks
- Basic observability (structured logs + request IDs)

### Slice B — User experience

- Chat UI + send/receive messages
- Care status panel and timeline
- Quick actions that create canonical events

### Slice C — AI orchestration

- Context builder + prompt template
- Structured response generation/validation
- Message persistence + conversation memory summarization

### Slice D — Adherence and escalation

- Event-to-action routing matrix
- Reminder scheduling
- Escalation creation and queue API

### Slice E — KPI instrumentation

- Retention and weekly engagement events
- Adherence numerator/denominator tracking
- Consult-to-second-action funnel markers

---

## 10) KPI instrumentation definitions

- **Post-consult retention (7/30/90)**:
  - Users with at least one qualifying interaction after consult in each window / users with consult in cohort
- **Medication adherence rate**:
  - Logged medication actions on expected days / expected medication days
- **Weekly AI engagement**:
  - Users with >=1 assistant interaction in rolling 7 days / active users
- **Consult-to-second-action conversion**:
  - Users who complete a second meaningful action after consult / users with consult

---

## 11) Security, privacy, and compliance baseline

- Encrypt PHI/PII at rest and in transit
- Strict audit logging on clinical event ingestion and escalation creation
- Data minimization in prompts (only required context)
- Role-based access for escalation queue
- Configurable retention windows for conversation and event payloads

---

## 12) Testing strategy

- Unit tests:
  - Event normalization, routing, and escalation rules
- Integration tests:
  - OpenLoop/pharmacy webhook to event log to AI response path
- Contract tests:
  - Webhook payload mapping and schema validation
- End-to-end happy path:
  - Consult complete -> AI follow-up -> shipment event -> adherence nudge
- Safety regression tests:
  - Non-diagnostic policy and escalation triggering behavior

