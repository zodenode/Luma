# AI Coaching MVP (OpenLoop Wrapper) — Product Requirements Document

## 1) Product summary

A chat-first AI health coaching layer that sits on top of telehealth consultations and pharmacy fulfillment.

It connects:

- Clinical consultation outcomes (via OpenLoop)
- Prescriptions and fulfillment status (via pharmacy integrations)
- Patient behavior and check-ins
- AI-generated coaching responses

The product purpose is to increase post-consult retention and treatment adherence through continuous, AI-led engagement.

---

## 2) Core user journey

### Step 1 — Intake

User selects:

- Health goal (for example: hormones, weight loss, energy)
- Symptoms
- Basic health history

Result: triggers eligibility flow for telehealth consultation.

### Step 2 — Consultation (external system)

Handled by OpenLoop.

Outputs from OpenLoop:

- Diagnosis and treatment plan
- Prescription (if applicable)

### Step 3 — Activation (this product starts here)

System receives:

- `consult_completed` event
- `prescription_issued` event (if applicable)

User transitions into:

> AI Care Loop

### Step 4 — AI coaching loop (core experience)

Primary interface: AI chat.

AI provides:

- Treatment explanation
- Daily actions
- Symptom interpretation
- Adherence support
- Behavioral nudges

### Step 5 — Fulfillment and adherence loop

Pharmacy events trigger:

- Shipping updates
- Medication start reminders
- Refill prompts

AI messaging adapts to:

- Adherence signals
- User feedback
- Symptom reports

### Step 6 — Escalation (human or clinical)

If risk or non-response is detected:

- Case is flagged
- Routed to clinician or coach (via OpenLoop or internal queue)

---

## 3) Core product features

### 3.1 Chat-based AI coach (primary UI)

A conversational interface that:

- Acts as daily health assistant
- Interprets clinical events
- Generates structured guidance
- Maintains continuity over time

### 3.2 Care status panel (secondary UI)

Persistent sidebar showing:

- Active treatment status
- Medication state (`not_started`, `active`, `shipped`)
- Next recommended action
- Adherence indicator

### 3.3 Care timeline (light history view)

Chronological list of:

- Consult completed
- Prescription issued
- Medication shipped
- Check-ins completed
- Alerts triggered

Purpose: user context and continuity (not analytics).

### 3.4 Quick actions bar

Persistent actions:

- Check in symptom
- Log medication
- Ask AI question
- Request help

---

## 4) MVP system architecture

### Frontend

- Web-first chat interface
- Minimal care status sidebar
- Lightweight timeline
- Quick action input layer

### Backend (thin orchestration layer)

Core services:

1. Intake service
2. Event ingestion service
3. AI response service
4. Webhook handlers (OpenLoop + pharmacy)
5. User state store

---

## 5) Event model (critical abstraction)

All system behavior is event-driven.

Canonical event types:

- `consult_completed`
- `prescription_issued`
- `medication_shipped`
- `user_checkin`
- `symptom_reported`
- `adherence_missed`

Each event triggers one or more:

- AI response
- Reminder
- Escalation

---

## 6) AI coaching engine requirements

The AI layer must:

- Interpret incoming events in user context
- Generate structured coaching responses
- Maintain continuity across sessions

Supported output types:

- Daily guidance
- Behavioral nudges
- Clinical explanations (non-diagnostic)
- Escalation flags

Guardrails:

- Do not issue diagnosis or prescribe treatment changes
- Route potential clinical risk signals into escalation flow
- Preserve clear distinction between coaching and clinical care

---

## 7) Simplified data model

### User

- `id`
- `goal`
- `linked_openloop_id`

### Treatment state

- `active_medication`
- `stage` (`pre_consult` | `post_consult` | `active_treatment`)

### Event log

- `type`
- `timestamp`
- `payload`

### Conversation memory

- Summaries of past AI interactions

---

## 8) Integration points

### Telehealth provider (OpenLoop)

- Consultation lifecycle events
- Prescription issuance webhook

### Pharmacy

- Fulfillment status webhook
- Medication delivery events

---

## 9) Explicit non-goals for MVP

Not included in this MVP:

- Full EHR replacement
- Coaching marketplace
- RPM / wearable integrations
- Complex analytics dashboards
- Multi-provider orchestration engine

---

## 10) Success metrics

Primary KPIs:

- Post-consult retention (7 / 30 / 90 day)
- Medication adherence rate
- Percentage of users engaging with AI weekly
- Consult-to-second-action conversion rate

---

## 11) Product principle

> Every clinical event must produce an AI-driven follow-up action inside the user experience.
