# Luma

This repository contains two runnable stacks:

1. **Next.js app** — AI coaching MVP (OpenLoop wrapper): chat-first care loop, event ingestion, v1 APIs, JSON file store (`data/luma.json`). See [Next.js: AI Coaching MVP](#nextjs-ai-coaching-mvp) below.
2. **Python backend** — FastAPI care engine with SQLite, JSON rules, retention features, and structured coaching context. See [Python: Care engine](#python-care-engine) below.

---

## Next.js: AI Coaching MVP

A chat-first AI health coaching layer on top of telehealth and pharmacy fulfilment. Every clinical event can produce an AI-driven follow-up in the UX.

### Stack

- **Next.js 14** (App Router) + **React 18** + **TypeScript**
- **Tailwind CSS**
- **OpenAI** for coaching (deterministic mock fallback without `OPENAI_API_KEY`)
- **JSON file store** at `data/luma.json` (event log, users, treatment state, messages, memory, escalations, KPI/audit helpers)

### Getting started (Next.js)

```bash
npm install
cp .env.example .env          # optional: OPENAI_API_KEY, webhook HMAC secrets
npm run seed                  # optional: demo patient + events
npm run dev                   # http://localhost:3000
```

Complete intake on `/` or use the seed URL for `/care/<user-id>`.

### Product flow

From the care loop: **Simulate event** (header) drives external events; **quick actions** log doses, symptoms, and help requests. Free-form chat uses `/api/v1/chat/message`. Session rehydration: `GET /api/v1/chat/session` and `POST /api/v1/chat/session/open`.

Engineering plan and PRD: `docs/ai-coaching-mvp-engineering-plan.md`, `docs/ai-coaching-mvp-prd.md`. Postgres reference DDL: `db/schema.sql`.

### Next.js scripts

| Command | Purpose |
|--------|---------|
| `npm run dev` | Dev server :3000 |
| `npm run build` / `npm start` | Production |
| `npm run typecheck` / `npm run lint` | Quality |
| `npm test` | Vitest (HMAC, escalation, event idempotency) |
| `npm run seed` | Demo data |

### Legacy / v1 API (Next)

- Legacy: `POST /api/webhooks/*` (shared secret header), `POST /api/chat`, `POST /api/actions`
- v1: `/api/v1/chat/*`, `/api/v1/care/*`, `/api/v1/actions/*`, `/api/v1/webhooks/*` (HMAC when secrets set), `/api/v1/escalations`, `/api/v1/reminders/evaluate`

---

## Python: Care engine

Minimal **FastAPI** backend: ingest events, materialise user state, evaluate JSON rules, orchestrate actions, AI coaching with structured context.

### Run (Python)

```bash
python3 -m pip install -r requirements.txt
DATABASE_URL=sqlite:///./luma.db python3 -m uvicorn backend.main:app --reload
```

Open `http://127.0.0.1:8000/` for the retention dashboard static page, or `/static/retention.html`.

### Python tests

```bash
python3 -m pytest tests/ -q
```

### Folder structure (Python)

```
backend/
  main.py                 # FastAPI app + routes
  seed.py                 # DB init + default rules
  ai/                     # coaching + synthesis
  core/                   # database, models, events, state, scheduling, rules, actions, retention
  integrations/           # OpenLoop, pharmacy, SMS, clinician stubs
  services/care_pipeline.py
tests/
```

### API routes (Python)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1/chat` | Chat → events → state → rules → actions → AI |
| POST | `/v1/events/symptom` | Symptom report |
| POST | `/v1/events/medication_missed` | Missed dose |
| POST | `/v1/events/consult_completed` | Consult completed |
| POST | `/v1/events/prescription_schedule` | Rx schedule (`prescription_schedule_set`) |
| GET | `/v1/users/{external_user_id}/state` | Materialised state + retention |
| POST | `/v1/events/daily_check_in` | Daily retention touch |
| POST | `/v1/events/series_measurement` | Longitudinal series point |
| POST | `/v1/events/weekly_reflection` | Weekly reflection text |

`user_id` in JSON bodies is the **external** id (`users.external_id`).

### Prescription schedule (Python)

Post to `/v1/events/prescription_schedule` with `schedule.version`, `medications[]` with `timezone`, `doses[]` using `time_local` (`HH:MM`) and optional `days_of_week`. Latest successful post wins in `user_state` snapshot field `prescription_schedule`.

### Database (Python)

- **users** — UUID + `external_id`
- **events** — append-only JSON payloads
- **user_state** — JSON snapshot (includes `retention`, streaks, series, reflections)
- **rules** / **actions_log** — rule engine and orchestration audit

Default seeded rule example: `medication_missed` count in last 7 days `> 2` → `send_ai_message`, `schedule_checkin`, `notify_clinician`.

Integrate a real LLM in `backend/ai/coaching.generate_coaching_response` without changing route contracts.
