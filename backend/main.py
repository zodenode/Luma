from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
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
    ingest_external_series,
    ingest_symptom,
    process_chat_turn,
    record_biomarker,
    record_consult_completed,
    record_cost_quote,
    record_daily_checkin,
    record_medication_missed,
    record_weekly_reflection,
    set_prescription_schedule,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    bootstrap()
    yield


app = FastAPI(title="Luma Care API", lifespan=lifespan)

_STATIC_DIR = Path(__file__).resolve().parent / "static"
if _STATIC_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=str(_STATIC_DIR)), name="static")


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
    note: str | None = None


class WeeklyReflectionRequest(BaseModel):
    user_id: str
    differences_noted: str = Field(..., min_length=1, max_length=8000)
    week_label: str | None = None
    focus_area: str | None = None


class BiomarkerRequest(BaseModel):
    user_id: str
    metric_key: str = Field(..., min_length=1, max_length=128)
    value: float
    unit: str | None = None
    source: str | None = None
    recorded_at: str | None = Field(
        None,
        description="ISO-8601 timestamp; defaults to now",
    )


class CostQuoteRequest(BaseModel):
    user_id: str
    amount: float
    currency: str = "USD"
    reason: str | None = None
    pharmacy_or_platform: str | None = None


class ExternalSeriesPoint(BaseModel):
    metric_key: str
    value: float
    recorded_at: str | None = None
    unit: str | None = None


class ExternalSeriesRequest(BaseModel):
    user_id: str
    points: list[ExternalSeriesPoint]
    platform: str | None = None


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
    return record_daily_checkin(db, user, req.mood_1_5, req.note)


@app.post("/v1/events/weekly_reflection")
def post_weekly_reflection(req: WeeklyReflectionRequest, db: Session = Depends(get_db)) -> dict:
    user = get_or_create_user(db, req.user_id)
    return record_weekly_reflection(
        db, user, req.differences_noted, req.week_label, req.focus_area
    )


@app.post("/v1/events/biomarker")
def post_biomarker(req: BiomarkerRequest, db: Session = Depends(get_db)) -> dict:
    user = get_or_create_user(db, req.user_id)
    recorded_at = None
    if req.recorded_at:
        try:
            recorded_at = datetime.fromisoformat(req.recorded_at.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid_recorded_at") from None
    return record_biomarker(
        db, user, req.metric_key, req.value, req.unit, req.source, recorded_at
    )


@app.post("/v1/events/cost_quote")
def post_cost_quote(req: CostQuoteRequest, db: Session = Depends(get_db)) -> dict:
    user = get_or_create_user(db, req.user_id)
    return record_cost_quote(
        db, user, req.amount, req.currency, req.reason, req.pharmacy_or_platform
    )


@app.post("/v1/events/external_series")
def post_external_series(req: ExternalSeriesRequest, db: Session = Depends(get_db)) -> dict:
    user = get_or_create_user(db, req.user_id)
    raw_points = [p.model_dump(exclude_none=True) for p in req.points]
    return ingest_external_series(db, user, raw_points, req.platform)
