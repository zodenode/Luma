from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import RedirectResponse
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
    record_daily_check_in,
    record_medication_missed,
    record_series_measurement,
    record_weekly_reflection,
    set_prescription_schedule,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    bootstrap()
    yield


app = FastAPI(title="Luma Care API", lifespan=lifespan)

_static_dir = Path(__file__).resolve().parent / "static"
if _static_dir.is_dir():
    app.mount("/static", StaticFiles(directory=str(_static_dir)), name="static")


@app.get("/")
def root() -> RedirectResponse:
    return RedirectResponse(url="/static/retention.html")


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


class DailyCheckInRequest(BaseModel):
    user_id: str
    mood: int | None = Field(None, ge=1, le=5, description="Optional 1–5 mood")
    note: str | None = None
    date_local: str | None = Field(None, description="YYYY-MM-DD in user's local day if backfilling")


class SeriesMeasurementRequest(BaseModel):
    user_id: str
    series_id: str = Field(..., description="Stable id e.g. weight_kg, bmi, out_of_pocket_usd")
    value: float
    unit: str | None = None
    source: str | None = Field(None, description="e.g. patient_entered, pharmacy_estimate, import")
    label: str | None = None


class WeeklyReflectionRequest(BaseModel):
    user_id: str
    text: str
    week_index: int | None = None
    theme: str | None = None
    tags: list[str] | None = None


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


@app.post("/v1/events/daily_check_in")
def post_daily_check_in(req: DailyCheckInRequest, db: Session = Depends(get_db)) -> dict:
    user = get_or_create_user(db, req.user_id)
    return record_daily_check_in(db, user, req.mood, req.note, req.date_local)


@app.post("/v1/events/series_measurement")
def post_series_measurement(req: SeriesMeasurementRequest, db: Session = Depends(get_db)) -> dict:
    user = get_or_create_user(db, req.user_id)
    return record_series_measurement(
        db, user, req.series_id, req.value, req.unit, req.source, req.label
    )


@app.post("/v1/events/weekly_reflection")
def post_weekly_reflection(req: WeeklyReflectionRequest, db: Session = Depends(get_db)) -> dict:
    user = get_or_create_user(db, req.user_id)
    return record_weekly_reflection(db, user, req.text, req.week_index, req.theme, req.tags)
