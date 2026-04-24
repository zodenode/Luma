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
- `CareContextCard` (pinned): treatment status, focus areas, last update, next action

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

7. **Chat State Rehydration Service**
   - Resolves chat startup context on app open
   - Loads last N messages + structured state + latest memory snapshot
   - Returns deterministic context packet for AI resume behavior

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

### 5.7 `memory_snapshots`

- `id` (pk)
- `user_id` (indexed)
- `summary` (text)
- `open_threads` (jsonb array)
- `source_message_from_id` (nullable fk messages.id)
- `source_message_to_id` (nullable fk messages.id)
- `created_at` (indexed)

### 5.8 `chat_sessions`

- `id` (pk)
- `user_id` (indexed)
- `rehydrated_snapshot_id` (nullable fk memory_snapshots.id)
- `started_at`
- `last_seen_at`

---

## 5A) Exact Postgres schema (DDL + indexes)

```sql
CREATE TYPE treatment_stage AS ENUM ('pre_consult', 'post_consult', 'active_treatment');
CREATE TYPE medication_status AS ENUM ('none', 'prescribed', 'shipped', 'active');
CREATE TYPE adherence_indicator AS ENUM ('unknown', 'good', 'at_risk');
CREATE TYPE message_role AS ENUM ('user', 'assistant', 'system');

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  linked_openloop_id TEXT UNIQUE,
  goal TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE treatment_states (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stage treatment_stage NOT NULL DEFAULT 'pre_consult',
  active_medication JSONB,
  medication_status medication_status NOT NULL DEFAULT 'none',
  adherence_indicator adherence_indicator NOT NULL DEFAULT 'unknown',
  adherence_score NUMERIC(5,4) CHECK (adherence_score IS NULL OR (adherence_score >= 0 AND adherence_score <= 1)),
  key_symptoms JSONB NOT NULL DEFAULT '[]'::jsonb,
  latest_lab_summary TEXT,
  next_recommended_action TEXT,
  last_interaction_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  idempotency_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE messages (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role message_role NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE conversation_memory (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  summary TEXT NOT NULL DEFAULT '',
  open_threads JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_summarized_message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE memory_snapshots (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  open_threads JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_message_from_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  source_message_to_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE escalations (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  linked_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE chat_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rehydrated_snapshot_id BIGINT REFERENCES memory_snapshots(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_user_occurred_at ON events(user_id, occurred_at DESC);
CREATE INDEX idx_events_type_occurred_at ON events(type, occurred_at DESC);
CREATE INDEX idx_messages_user_created_at ON messages(user_id, created_at DESC);
CREATE INDEX idx_memory_snapshots_user_created_at ON memory_snapshots(user_id, created_at DESC);
CREATE INDEX idx_escalations_user_status_created_at ON escalations(user_id, status, created_at DESC);
CREATE INDEX idx_chat_sessions_user_last_seen ON chat_sessions(user_id, last_seen_at DESC);
CREATE INDEX idx_treatment_states_last_interaction ON treatment_states(last_interaction_at DESC);
```

---

## 6) API contract (MVP)

### 6.1 User-facing endpoints

- `GET /v1/chat/session`
  - Rehydrates chat with:
    - last 20 messages
    - latest structured state
    - latest memory snapshot (summary + open threads)
- `POST /v1/chat/message`
  - Persists raw message record and triggers AI response pipeline
- `GET /v1/care/state`
  - Returns stage, medication status, adherence indicator, next action
- `GET /v1/care/timeline?cursor=...`
  - Returns canonical events for timeline display
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

### 6.3 Memory maintenance endpoints (internal/system)

- `POST /v1/chat/summarise`
  - Triggered every 5-10 new messages (or token threshold)
  - Writes:
    - `conversation_memory` current summary
    - immutable `memory_snapshots` row
  - Extracts `open_threads` for next-session follow-up

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

### 7.1 Chat resurrection flow (required on app open)

1. `GET /v1/chat/session`
2. Load:
   - latest structured state (`treatment_states`)
   - latest memory snapshot (`memory_snapshots` or `conversation_memory`)
   - last 20 messages (`messages`)
3. Build deterministic context packet and store `chat_sessions` entry
4. First assistant message references prior state and resumes open thread(s)

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

### 7.2 Prompt contract for consistent long-term coaching voice

System prompt skeleton:

```text
You are the user's ongoing health coach for longitudinal care support.
You are non-diagnostic and must not prescribe treatment changes.
You maintain continuity across sessions by using provided USER_STATE, MEMORY_SNAPSHOT, and RECENT_MESSAGES.
When the user returns, acknowledge prior context and continue open threads naturally.
If risk signals appear, recommend escalation using configured policy.
Tone: warm, concise, practical, supportive, and accountability-oriented.
```

Context injection template:

```text
USER_STATE:
- goal: {{goal}}
- treatment_stage: {{stage}}
- active_medication: {{active_medication}}
- adherence_score: {{adherence_score}}
- key_symptoms: {{key_symptoms}}
- latest_lab_summary: {{latest_lab_summary}}
- last_interaction_at: {{last_interaction_at}}

MEMORY_SNAPSHOT:
- summary: {{summary}}
- open_threads: {{open_threads}}
- snapshot_created_at: {{snapshot_created_at}}

RECENT_MESSAGES (last 20):
{{recent_messages}}
```

Response requirements:

- Start with continuity signal when session is resumed (for example: "Good to see you back...")
- Advance one open thread plus one concrete next action
- Avoid re-asking already known background unless needed for safety
- Emit structured JSON fields required by downstream systems

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
- Message persistence and retrieval primitives

### Slice B — User experience

- Chat UI + send/receive messages
- Care status panel and timeline
- Quick actions that create canonical events
- Continue conversation startup flow (`GET /v1/chat/session`)
- Pinned care context card

### Slice C — AI orchestration

- Context builder + prompt template
- Structured response generation/validation
- Message persistence + conversation memory summarization
- Scheduled or threshold-based summarization job (every 5-10 messages)
- Open thread extraction and carry-forward

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

