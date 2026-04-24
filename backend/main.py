from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

from datetime import datetime

from fastapi import Depends, FastAPI
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.core.db.models import Event, Rule, UserState
from backend.core.db.session import get_session_factory, init_db
from backend.core.events import CareEventCreate
from backend.services.care_pipeline import (
    process_structured_event,
    process_user_chat_message,
    seed_default_rules,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    factory = get_session_factory()
    with factory() as session:
        seed_default_rules(session)
        session.commit()
    yield


app = FastAPI(title="Luma Care Engine", lifespan=lifespan)


def get_db():
    factory = get_session_factory()
    session = factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


class ChatMessage(BaseModel):
    role: str = Field(..., pattern="^(user|assistant)$")
    content: str


class ChatRequest(BaseModel):
    user_id: str
    message: str
    history: list[ChatMessage] = Field(default_factory=list)


class ChatResponse(BaseModel):
    reply: str
    trace: dict[str, Any]


@app.post("/chat", response_model=ChatResponse)
def chat(req: ChatRequest, db: Session = Depends(get_db)):
    """Backward-compatible chat: same path, now runs the full care pipeline."""
    hist = [m.model_dump() for m in req.history]
    result = process_user_chat_message(db, req.user_id, req.message, hist)
    return ChatResponse(reply=result["reply"], trace=result["trace"])


class EventIngestRequest(BaseModel):
    event_type: str
    user_id: str
    timestamp: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


@app.post("/events")
def ingest_care_event(body: EventIngestRequest, db: Session = Depends(get_db)):
    ts = None
    if body.timestamp:
        raw = body.timestamp.replace("Z", "+00:00") if body.timestamp.endswith("Z") else body.timestamp
        ts = datetime.fromisoformat(raw)
    data = CareEventCreate(event_type=body.event_type, user_id=body.user_id, timestamp=ts, payload=body.payload)
    return process_structured_event(db, data, extra_action_context={"sms_body": body.payload.get("sms_body")})


@app.get("/users/{user_id}/state")
def get_state(user_id: str, db: Session = Depends(get_db)):
    row = db.get(UserState, user_id)
    if row is None:
        return {
            "user_id": user_id,
            "adherence_score": None,
            "risk_level": None,
            "active_treatment_status": None,
            "last_lab_summary": None,
            "last_interaction_at": None,
        }
    return {
        "user_id": user_id,
        "adherence_score": row.adherence_score,
        "risk_level": row.risk_level,
        "active_treatment_status": row.active_treatment_status,
        "last_lab_summary": row.last_lab_summary,
        "last_interaction_at": row.last_interaction_at.isoformat() if row.last_interaction_at else None,
    }


@app.get("/users/{user_id}/events")
def list_events(user_id: str, limit: int = 50, db: Session = Depends(get_db)):
    q = select(Event).where(Event.user_id == user_id).order_by(Event.timestamp.desc()).limit(limit)
    rows = db.scalars(q).all()
    return [
        {
            "id": e.id,
            "event_type": e.event_type,
            "timestamp": e.timestamp.isoformat(),
            "payload": e.payload or {},
        }
        for e in rows
    ]


@app.get("/rules")
def list_rules(db: Session = Depends(get_db)):
    q = select(Rule).order_by(Rule.created_at.asc())
    rows = db.scalars(q).all()
    return [
        {"id": r.id, "name": r.name, "enabled": r.enabled, "definition": r.definition} for r in rows
    ]


class RuleCreate(BaseModel):
    name: str
    definition: dict[str, Any]


@app.post("/rules")
def create_rule(body: RuleCreate, db: Session = Depends(get_db)):
    r = Rule(name=body.name, definition=body.definition, enabled=True)
    db.add(r)
    db.flush()
    return {"id": r.id, "name": r.name, "definition": r.definition}
