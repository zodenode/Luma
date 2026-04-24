# Luma — AI Coaching MVP (OpenLoop Wrapper)

A chat-first AI health coaching layer that sits on top of telehealth consultations
and pharmacy fulfilment. Every clinical event produces an AI-driven follow-up in
the user experience.

This repo is a runnable MVP of the PRD: intake → consult (external) → AI care
loop → fulfilment → adherence → escalation.

## Stack

- **Next.js 14** (App Router) + **React 18** + **TypeScript**
- **Tailwind CSS** for the UI
- **OpenAI** for coaching replies (with a deterministic mock fallback — the app
  runs with no API key)
- **JSON file store** at `data/luma.json` for the event log, users, treatment
  state, messages, conversation memory, memory snapshots, escalations, chat
  sessions, and KPI markers (simple, swappable)

**Postgres:** the canonical DDL from the engineering plan lives at
`db/migrations/001_ai_coaching_mvp.sql` for production deployments; the default
dev path remains the JSON store.

## Getting started

```bash
npm install
cp .env.example .env.local   # optional: add OPENAI_API_KEY
npm run seed                 # optional: creates a demo patient + events
npm run dev
```

Open http://localhost:3000.

If you ran the seed, the demo patient URL is printed in the terminal
(`/care/<user-id>`). Otherwise complete intake on the landing page and you'll
land straight in the AI Care Loop.

## What to try

From the care loop view, use the **⚡ Simulate event** button (top right) to
trigger the events an external system would normally send:

- `consult_completed` (OpenLoop)
- `prescription_issued` (OpenLoop)
- `medication_shipped` / `medication_delivered` / `refill_due` (pharmacy)
- `adherence_missed` (system)

Each event:

1. is persisted to the **event log**,
2. updates **treatment state** via a reducer,
3. triggers an **AI follow-up message** in the chat.

You can also use the **quick actions bar**:

- ✅ Log dose taken / ⏭️ Missed dose — adherence signal
- 📝 Check-in symptom — severity 0–10
- 💬 Ask AI about my plan — routes through the coach
- 🆘 Request help — fires an escalation event

Free-form chat is grounded in the user's profile, treatment state, recent
messages, and a rolling conversation summary.

## Product principle implemented

> "Every clinical event must produce an AI-driven follow-up action within the
> user experience."

This is enforced in `src/lib/events.ts` → `ingestEvent()`. Every inbound event
(from users, OpenLoop webhooks, pharmacy webhooks, or internal schedulers)
flows through a single pipeline:

```text
ingestEvent(event)
  → append to event log
  → reduce treatment state (stage, medication, adherence, risk)
  → generate AI follow-up (chat / nudge / escalation)
  → auto-escalate on red flags
```

## Architecture

### Frontend (`src/app`, `src/components`)

- `/` — landing + intake form
- `/care/[userId]` — the AI Care Loop:
  - **Chat** (primary UI) — `ChatView`, chat composer
  - **Care status panel** — stage, medication state, adherence, next action
  - **Care timeline** — chronological event list
  - **Quick actions bar** — log dose, check-in symptom, ask AI, request help
- A `SimulatePanel` in the header lets you fire external events for demo

The care loop calls `GET /api/v1/chat/session` on mount (rehydration) and polls
`/api/users/[userId]` every 4 seconds so events triggered elsewhere (webhooks,
other tabs) appear without a reload.

### Backend (`src/app/api`)

Thin orchestration layer — the PRD's five services, kept flat:

| Service | Implementation |
| --- | --- |
| Intake service | `POST /api/intake` → `lib/intake.ts` |
| Event ingestion service | `lib/events.ts` (`ingestEvent`) |
| AI response service | `lib/ai.ts` (`generateEventFollowup`, `generateChatReply`, `summarizeConversation`) |
| Webhook handlers | `POST /api/webhooks/*` (shared secret or HMAC) and `POST /api/v1/webhooks/*` (HMAC) |
| User state store | `lib/store.ts` (JSON file, atomic writes, serialized) |

**Versioned API (`/api/v1/...`)** — matches `docs/ai-coaching-mvp-engineering-plan.md`:

- `GET /api/v1/chat/session?userId=` — last 20 messages + treatment state + memory snapshot; optional resume reply
- `POST /api/v1/chat/message` — user chat (single AI reply; `user_checkin` uses `skipFollowup` to avoid double responses)
- `POST /api/v1/chat/summarise` — force summary + snapshot
- `GET /api/v1/care/state`, `GET /api/v1/care/timeline`
- `POST /api/v1/actions/checkin`, `log-medication`, `request-help`
- `GET /api/v1/escalations` — clinician queue
- `POST /api/v1/webhooks/openloop` | `pharmacy` — HMAC body verification

Legacy shortcuts (still work): `POST /api/chat`, `POST /api/actions`, `POST /api/simulate`,
`GET /api/users`, `GET /api/users/[userId]`.

### Event model

All system behaviour is driven by events. Types live in `src/lib/types.ts`:

```
intake_completed | consult_scheduled | consult_completed |
prescription_issued | medication_shipped | medication_delivered |
user_checkin | symptom_reported | adherence_missed | adherence_confirmed |
refill_due | request_help | ai_response_generated | escalation_created |
escalation_triggered | ai_followup | kpi_*
```

Each event has `{ id, user_id, type, occurred_at, received_at, idempotency_key, source, payload }` and is
appended to the event log. The reducer in `lib/events.ts` maps events →
treatment state updates (stage transitions, medication state, adherence score,
risk flags). The AI layer turns every event into a coach message.

### Data model

See `src/lib/types.ts`. Matches the PRD:

- `User` — `id`, `goal`, `linked_openloop_id`
- `TreatmentState` — `stage`, `medication`, `adherence_score`, `next_recommended_action`, `risk_flags`
- `CareEvent` — event log entry
- `ChatMessage` — conversation history (with `event_id` back-links)
- `ConversationMemory` — rolling summary + `open_threads`
- `MemorySnapshot`, `EscalationRecord`, `ChatSession`, `KpiMarker` — plan tables (JSON-backed)

### AI coaching engine

`src/lib/ai.ts` exposes three primitives:

- `generateEventFollowup(event)` — clinical/system event → coach message
- `generateChatReply({ userId, history })` — user message → coach reply
- `summarizeConversation(messages)` — rolling memory (default every 8 messages via `CHAT_SUMMARY_EVERY_N`)
- Structured coach JSON: `response_type`, `message`, `next_actions`, `adherence_risk`, `escalation_recommended`

All prompts include:

- the user's goal, intake symptoms, and history
- current treatment stage and medication state
- adherence score and risk flags
- the rolling conversation summary

All three fall back to deterministic mock responses if `OPENAI_API_KEY` is not
set — useful for demos, CI, and local development.

### Escalation

Paths include: red-flag chat keywords → `escalation_triggered` (AI source);
`request_help` → queue row + coach message; symptom severity ≥8 → `escalation_created`;
rolling `adherence_missed` count → `adherence_decline` queue entry. List open items via
`GET /api/v1/escalations?status=open`.

## Webhook integration

### OpenLoop

```bash
curl -X POST http://localhost:3000/api/webhooks/openloop \
  -H "content-type: application/json" \
  -H "x-webhook-secret: dev-openloop-secret" \
  -d '{
    "event": "consult_completed",
    "userId": "usr_xxx",
    "data": {
      "diagnosis": "Subclinical hormone imbalance",
      "plan_summary": "8-week protocol: daily medication + weekly check-ins."
    }
  }'
```

Supported events: `consult_scheduled`, `consult_completed`, `prescription_issued`.

The user may be resolved by `userId` (Luma ID) or `openloopId`
(`User.linked_openloop_id`).

### Pharmacy

```bash
curl -X POST http://localhost:3000/api/webhooks/pharmacy \
  -H "content-type: application/json" \
  -H "x-webhook-secret: dev-pharmacy-secret" \
  -d '{ "event": "medication_shipped", "userId": "usr_xxx" }'
```

Supported events: `medication_shipped`, `medication_delivered`, `refill_due`.

Verify with `x-webhook-secret` **or** HMAC: set `OPENLOOP_WEBHOOK_HMAC_SECRET` /
`PHARMACY_WEBHOOK_HMAC_SECRET` and send header `X-Signature: sha256=<hex>` over the
raw request body. Pass `idempotency_key` in JSON for safe retries.

## KPIs

The event log remains the source of truth; the MVP also appends lightweight
`kpi_*` markers (`lib/kpi.ts`) for retention windows, weekly assistant engagement,
adherence ratio events, and consult-to-second-action after the second meaningful
post-consult action.

## Non-goals (per PRD §9)

Not included, on purpose: full EHR replacement, coaching marketplace,
wearables/RPM, complex analytics dashboards, multi-provider orchestration.

## Scripts

- `npm run dev` — Next.js dev server on :3000
- `npm run build` / `npm start` — production build
- `npm run typecheck` — TypeScript check
- `npm run lint` — Next.js ESLint
- `npm run test` — Vitest unit tests
- `npm run seed` — create a demo patient pre-loaded with consult + prescription + shipment events
