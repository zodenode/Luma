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
  state, messages, and conversation memory (simple, swappable)

No database, no build tools you don't already have.

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

The care loop view polls `/api/users/[userId]` every 4 seconds so events
triggered elsewhere (webhooks, other tabs) appear without a reload.

### Backend (`src/app/api`)

Thin orchestration layer — the PRD's five services, kept flat:

| Service | Implementation |
| --- | --- |
| Intake service | `POST /api/intake` → `lib/intake.ts` |
| Event ingestion service | `lib/events.ts` (`ingestEvent`) |
| AI response service | `lib/ai.ts` (`generateEventFollowup`, `generateChatReply`, `summarizeConversation`) |
| Webhook handlers | `POST /api/webhooks/openloop`, `POST /api/webhooks/pharmacy` |
| User state store | `lib/store.ts` (JSON file, atomic writes, serialized) |

Plus:

- `POST /api/chat` — user chat turn (logs `user_checkin` + replies)
- `POST /api/actions` — quick-actions entry point
- `POST /api/simulate` — dev-only shortcut that fires any external event
- `GET  /api/users` / `GET /api/users/[userId]` — read-through for the UI

### Event model

All system behaviour is driven by events. Types live in `src/lib/types.ts`:

```
intake_completed | consult_scheduled | consult_completed |
prescription_issued | medication_shipped | medication_delivered |
user_checkin | symptom_reported | adherence_missed | adherence_confirmed |
refill_due | escalation_triggered | ai_followup
```

Each event has `{ id, user_id, type, timestamp, source, payload }` and is
appended to the event log. The reducer in `lib/events.ts` maps events →
treatment state updates (stage transitions, medication state, adherence score,
risk flags). The AI layer turns every event into a coach message.

### Data model

See `src/lib/types.ts`. Matches the PRD:

- `User` — `id`, `goal`, `linked_openloop_id`
- `TreatmentState` — `stage`, `medication`, `adherence_score`, `next_recommended_action`, `risk_flags`
- `CareEvent` — event log entry
- `ChatMessage` — conversation history (with `event_id` back-links)
- `ConversationMemory` — rolling summary used to keep continuity

### AI coaching engine

`src/lib/ai.ts` exposes three primitives:

- `generateEventFollowup(event)` — clinical/system event → coach message
- `generateChatReply({ userId, history })` — user message → coach reply
- `summarizeConversation(messages)` — rolling memory (~every 6 turns)

All prompts include:

- the user's goal, intake symptoms, and history
- current treatment stage and medication state
- adherence score and risk flags
- the rolling conversation summary

All three fall back to deterministic mock responses if `OPENAI_API_KEY` is not
set — useful for demos, CI, and local development.

### Escalation

Two paths produce an `escalation_triggered` event:

1. **Red-flag keyword detection** in user chat (chest pain, self-harm,
   anaphylaxis, severe bleeding, pregnancy) — handled in `detectRedFlags()`.
2. **User-initiated** via the 🆘 Request help quick action.

When escalated, the treatment stage flips to `escalated`, a `clinician_escalation`
risk flag is set, and the coach posts an acknowledgement message.

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

Both webhooks verify `x-webhook-secret` against `OPENLOOP_WEBHOOK_SECRET` /
`PHARMACY_WEBHOOK_SECRET`. If either env var is unset, verification is
skipped (dev mode).

## KPIs

The data needed to compute every PRD KPI is on the event log:

- **Post-consult retention (7 / 30 / 90d)** — time between `consult_completed`
  and the most recent `user_checkin` / `adherence_confirmed` / chat event
- **Medication adherence rate** — `adherence_confirmed` vs `adherence_missed`
  per user (also surfaced as `TreatmentState.adherence_score`)
- **% users engaging with AI weekly** — count unique users with a `user_checkin`
  event in a rolling 7-day window
- **Consult-to-second-action conversion** — users with `consult_completed` and
  at least one user-sourced event afterwards

An analytics dashboard is explicitly out of scope (per PRD §9) — the event log
is the source of truth.

## Non-goals (per PRD §9)

Not included, on purpose: full EHR replacement, coaching marketplace,
wearables/RPM, complex analytics dashboards, multi-provider orchestration.

## Scripts

- `npm run dev` — Next.js dev server on :3000
- `npm run build` / `npm start` — production build
- `npm run typecheck` — TypeScript check
- `npm run lint` — Next.js ESLint
- `npm run seed` — create a demo patient pre-loaded with consult + prescription + shipment events
