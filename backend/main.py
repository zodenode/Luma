from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.core.database import get_db
from backend.core.models import User
from backend.seed import bootstrap
from backend.services.care_pipeline import (
    get_or_create_user,
    get_state_view,
    ingest_symptom,
    process_chat_turn,
    record_consult_completed,
    record_medication_missed,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    bootstrap()
    yield


app = FastAPI(title="Luma Care API", lifespan=lifespan)


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


@app.get("/v1/users/{external_user_id}/state")
def user_state(external_user_id: str, db: Session = Depends(get_db)) -> dict:
    row = db.scalar(select(User).where(User.external_id == external_user_id))
    if not row:
        raise HTTPException(status_code=404, detail="user_not_found")
    return get_state_view(db, row)
