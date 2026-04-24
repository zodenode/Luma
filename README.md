# Luma

AI coaching backend with an event-driven care engine (ingest → state → rules → actions → coaching context).

## Run locally

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Key routes: `POST /chat`, `POST /api/events`, `GET /api/users/{id}/state`.

### Layout

- `backend/app/` — FastAPI app, SQLAlchemy models, care pipeline wiring, AI coaching wrapper
- `backend/core/` — care engine: `events/`, `state/`, `rules/`, `actions/`, `integrations/` (stubs)
- `backend/data/` — local SQLite (`luma.db`), gitignored
