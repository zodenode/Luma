from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.core.database import get_db
from backend.core.models import User
from backend.seed import bootstrap
from backend.core.scheduling import PrescriptionSchedulePayload
from backend.services.care_pipeline import (
    get_or_create_user,
    get_state_view,
    ingest_symptom,
    process_chat_turn,
    record_consult_completed,
    record_cost_barrier,
    record_daily_checkin,
    record_medication_missed,
    record_metric,
    set_prescription_schedule,
    submit_weekly_reflection,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    bootstrap()
    yield


app = FastAPI(title="Luma Care API", lifespan=lifespan)

_static_dir = Path(__file__).resolve().parent / "static"
if _static_dir.is_dir():
    app.mount("/static", StaticFiles(directory=str(_static_dir)), name="static")


@app.get("/retention")
def retention_dashboard() -> FileResponse:
    """Lightweight UI for retention metrics and event posting (dev / demo)."""
    path = _static_dir / "retention.html"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="retention_ui_not_found")
    return FileResponse(path)


class ChatRequest(BaseModel):
    user_id: str = Field(..., description="Stable external user id (maps to users.external_id)")
    message: str


class ChatResponse(BaseModel):
    reply: str
    trace: dict


class SymptomRequest(BaseModel):
    user_id: str
    symptom: str
    severity: int | None = None


class MedicationMissedRequest(BaseModel):
    user_id: str
    medication_id: str | None = None


class ConsultRequest(BaseModel):
    user_id: str
    summary: str | None = None


class PrescriptionScheduleRequest(BaseModel):
    user_id: str
    schedule: PrescriptionSchedulePayload


class DailyCheckinRequest(BaseModel):
    user_id: str
    mood_1_5: int | None = Field(None, ge=1, le=5)
    energy_1_5: int | None = Field(None, ge=1, le=5)
    note: str | None = None


class WeeklyReflectionRequest(BaseModel):
    user_id: str
    what_changed: str = Field(..., min_length=1)
    challenges: str | None = None
    week_number: int | None = Field(None, ge=1)


class MetricRecordedRequest(BaseModel):
    user_id: str
    metric_id: str = Field(..., min_length=1)
    value: float | str
    unit: str | None = None
    source: str | None = None
    note: str | None = None


class CostBarrierRequest(BaseModel):
    user_id: str
    amount_today: float | None = None
    currency: str | None = None
    reason: str | None = None
    source: str | None = None


@app.post("/v1/chat", response_model=ChatResponse)
def chat(req: ChatRequest, db: Session = Depends(get_db)) -> ChatResponse:
    """Backward-compatible chat: same path shape; response includes optional trace."""
    user = get_or_create_user(db, req.user_id)
    result = process_chat_turn(db, user, req.message)
    return ChatResponse(reply=result["reply"], trace=result["trace"])


@app.post("/v1/events/symptom")
def post_symptom(req: SymptomRequest, db: Session = Depends(get_db)) -> dict:
    user = get_or_create_user(db, req.user_id)
    return ingest_symptom(db, user, req.symptom, req.severity)


@app.post("/v1/events/medication_missed")
def post_medication_missed(req: MedicationMissedRequest, db: Session = Depends(get_db)) -> dict:
    user = get_or_create_user(db, req.user_id)
    return record_medication_missed(db, user, req.medication_id)


@app.post("/v1/events/consult_completed")
def post_consult(req: ConsultRequest, db: Session = Depends(get_db)) -> dict:
    user = get_or_create_user(db, req.user_id)
    return record_consult_completed(db, user, req.summary)


@app.post("/v1/events/prescription_schedule")
def post_prescription_schedule(req: PrescriptionScheduleRequest, db: Session = Depends(get_db)) -> dict:
    """Append prescription_schedule_set; latest schedule is materialised into user_state."""
    user = get_or_create_user(db, req.user_id)
    return set_prescription_schedule(db, user, req.schedule)


@app.get("/v1/users/{external_user_id}/state")
def user_state(external_user_id: str, db: Session = Depends(get_db)) -> dict:
    row = db.scalar(select(User).where(User.external_id == external_user_id))
    if not row:
        raise HTTPException(status_code=404, detail="user_not_found")
    return get_state_view(db, row)


@app.post("/v1/events/daily_checkin")
def post_daily_checkin(req: DailyCheckinRequest, db: Session = Depends(get_db)) -> dict:
    user = get_or_create_user(db, req.user_id)
    return record_daily_checkin(db, user, req.mood_1_5, req.energy_1_5, req.note)


@app.post("/v1/events/weekly_reflection")
def post_weekly_reflection(req: WeeklyReflectionRequest, db: Session = Depends(get_db)) -> dict:
    user = get_or_create_user(db, req.user_id)
    return submit_weekly_reflection(db, user, req.what_changed, req.challenges, req.week_number)


@app.post("/v1/events/metric")
def post_metric(req: MetricRecordedRequest, db: Session = Depends(get_db)) -> dict:
    user = get_or_create_user(db, req.user_id)
    return record_metric(db, user, req.metric_id, req.value, req.unit, req.source, req.note)


@app.post("/v1/events/cost_barrier")
def post_cost_barrier(req: CostBarrierRequest, db: Session = Depends(get_db)) -> dict:
    user = get_or_create_user(db, req.user_id)
    return record_cost_barrier(db, user, req.amount_today, req.currency, req.reason, req.source)
