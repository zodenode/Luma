# Luma

Minimal FastAPI backend with an event-driven **care engine**: ingest events, materialise user state, evaluate JSON rules, orchestrate actions, and wrap AI coaching with structured context.

## Run

```bash
python3 -m pip install -r requirements.txt
DATABASE_URL=sqlite:///./luma.db python3 -m uvicorn backend.main:app --reload
```

Tests:

```bash
python3 -m pytest tests/ -q
```

## Folder structure

```
backend/
  main.py                 # FastAPI app + routes
  seed.py                 # DB init + default rules
  ai/
    coaching.py           # AI context builder + MVP response (LLM seam)
  core/
    database.py           # SQLAlchemy engine/session
    models.py             # users, events, user_state, rules, actions_log
    events/               # ingestion + CareEvent schema
    state/                # snapshot refresh from events
    rules/                # JSON rule evaluation (v1)
    actions/              # orchestrator + action logging
  integrations/         # OpenLoop, pharmacy, SMS, clinician stubs
  services/
    care_pipeline.py      # chat + event flows
tests/
```

## API routes

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1/chat` | Chat (creates `chat_message_received` → state → rules → actions → AI) |
| POST | `/v1/events/symptom` | Symptom report |
| POST | `/v1/events/medication_missed` | Adherence / missed dose |
| POST | `/v1/events/consult_completed` | Consult completed |
| GET | `/v1/users/{external_user_id}/state` | Current materialised state snapshot |

`user_id` in JSON bodies is the **external** id (`users.external_id`); internal UUID is created automatically.

## Database schema

- **users** — `id` (UUID), `external_id` (unique), `created_at`
- **events** — append-only: `id`, `user_id`, `event_type`, `timestamp`, `payload` (JSON)
- **user_state** — one row per user: `user_id` (PK), `snapshot` (JSON), `updated_at`
- **rules** — `id`, `name`, `definition` (JSON), `enabled`, `created_at`
- **actions_log** — `id`, `user_id`, `action_type`, `payload`, `triggered_by_event_id`, `status`, `detail`, `created_at`

## Example event flow

1. Client `POST /v1/events/symptom` with `{"user_id":"alice","symptom":"headache","severity":6}`.
2. Row inserted into **events** (`symptom_reported`).
3. **user_state** recomputed from recent events (risk, adherence, last interaction, etc.).
4. **rules** evaluated; matching rule adds actions (e.g. `send_ai_message`).
5. **actions_log** rows written for each action; stubs return string details.
6. `coaching_preview` in the response uses `user_state`, `recent_events`, `active_rules`, `treatment_context`.

## Example rule evaluation

Default rule (seeded): medication escalation — if `event_type` is `medication_missed` and `count_last_7_days` of `medication_missed` events is `> 2`, fire actions `send_ai_message`, `schedule_checkin`, `notify_clinician`.

Rule JSON shape:

```json
{
  "event_type": "medication_missed",
  "count_event_type": "medication_missed",
  "conditions": { "count_last_7_days": "> 2" },
  "actions": ["send_ai_message", "schedule_checkin", "notify_clinician"]
}
```

Integrate a real LLM inside `backend/ai/coaching.generate_coaching_response` without changing route contracts.
