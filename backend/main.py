from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.core.database import get_db
from backend.core.models import User
from backend.seed import bootstrap
from backend.core.scheduling import PrescriptionSchedulePayload
from backend.services.care_pipeline import (
    get_or_create_user,
    get_retention_dashboard_view,
    get_state_view,
    ingest_symptom,
    process_chat_turn,
    record_clinical_metric,
    record_consult_completed,
    record_daily_checkin,
    record_external_sync,
    record_medication_missed,
    record_weekly_reflection,
    set_prescription_schedule,
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


class PrescriptionScheduleRequest(BaseModel):
    user_id: str
    schedule: PrescriptionSchedulePayload


class DailyCheckinRequest(BaseModel):
    user_id: str
    mood: int | None = Field(None, ge=1, le=10)
    energy: int | None = Field(None, ge=1, le=10)
    notes: str | None = None
    recorded_at: str | None = Field(
        None,
        description="ISO-8601 timestamp for this check-in (defaults to now; use for backfill)",
    )


class WeeklyReflectionRequest(BaseModel):
    user_id: str
    what_changed: str | None = None
    wins: str | None = None
    struggles: str | None = None
    week_label: str | None = None
    notes: str | None = None


class ClinicalMetricRequest(BaseModel):
    user_id: str
    series_key: str = Field(..., description="Stable key e.g. bmi, weight_kg, a1c")
    value: float
    unit: str | None = None
    observed_at: str | None = None
    source_platform: str | None = None
    label: str | None = None


class ExternalSyncRequest(BaseModel):
    user_id: str
    resource_type: str
    platform: str | None = None
    payload: dict | None = None


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


@app.get("/v1/users/{external_user_id}/dashboard")
def user_dashboard(external_user_id: str, db: Session = Depends(get_db)) -> dict:
    row = db.scalar(select(User).where(User.external_id == external_user_id))
    if not row:
        raise HTTPException(status_code=404, detail="user_not_found")
    return get_retention_dashboard_view(db, row)


@app.post("/v1/events/daily_checkin")
def post_daily_checkin(req: DailyCheckinRequest, db: Session = Depends(get_db)) -> dict:
    from datetime import datetime, timezone

    user = get_or_create_user(db, req.user_id)
    rec: datetime | None = None
    if req.recorded_at:
        try:
            rec = datetime.fromisoformat(req.recorded_at.replace("Z", "+00:00"))
        except ValueError:
            rec = None
    return record_daily_checkin(db, user, req.mood, req.energy, req.notes, recorded_at=rec)


@app.post("/v1/events/weekly_reflection")
def post_weekly_reflection(req: WeeklyReflectionRequest, db: Session = Depends(get_db)) -> dict:
    user = get_or_create_user(db, req.user_id)
    return record_weekly_reflection(
        db,
        user,
        req.what_changed,
        req.wins,
        req.struggles,
        req.week_label,
        req.notes,
    )


@app.post("/v1/events/clinical_metric")
def post_clinical_metric(req: ClinicalMetricRequest, db: Session = Depends(get_db)) -> dict:
    user = get_or_create_user(db, req.user_id)
    return record_clinical_metric(
        db,
        user,
        req.series_key,
        req.value,
        req.unit,
        req.observed_at,
        req.source_platform,
        req.label,
    )


@app.post("/v1/events/external_sync")
def post_external_sync(req: ExternalSyncRequest, db: Session = Depends(get_db)) -> dict:
    user = get_or_create_user(db, req.user_id)
    return record_external_sync(db, user, req.resource_type, req.platform, req.payload)


@app.get("/retention", response_class=HTMLResponse)
def retention_ui() -> HTMLResponse:
    """Minimal retention dashboard (served by API for demos)."""
    html = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Luma — Retention</title>
  <style>
    :root { font-family: system-ui, sans-serif; color: #0f172a; background: #f8fafc; }
    body { max-width: 960px; margin: 0 auto; padding: 1.5rem; }
    h1 { font-size: 1.35rem; margin: 0 0 0.5rem; }
    p.muted { color: #64748b; font-size: 0.9rem; margin: 0 0 1rem; }
    label { display: block; font-size: 0.8rem; color: #475569; margin-top: 0.75rem; }
    input, textarea, button, select { width: 100%; box-sizing: border-box; padding: 0.5rem; margin-top: 0.25rem; }
    textarea { min-height: 4rem; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
    .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 1rem; margin-bottom: 1rem; }
    pre { background: #0f172a; color: #e2e8f0; padding: 0.75rem; border-radius: 8px; overflow: auto; font-size: 0.75rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.75rem; }
    .stat { background: #f1f5f9; padding: 0.6rem 0.75rem; border-radius: 8px; font-size: 0.85rem; }
    .stat b { display: block; font-size: 1.1rem; }
    canvas { width: 100% !important; max-height: 220px; }
  </style>
</head>
<body>
  <h1>Retention dashboard</h1>
  <p class="muted">Daily check-ins, weekly reflections, longitudinal metrics, and synced cost context materialise into <code>user_state</code> for coaching continuity.</p>

  <div class="card">
    <label>External user id</label>
    <input id="uid" value="demo_user" />
    <div class="row">
      <div>
        <label>Mood (1–10)</label>
        <input id="mood" type="number" min="1" max="10" placeholder="optional" />
      </div>
      <div>
        <label>Energy (1–10)</label>
        <input id="energy" type="number" min="1" max="10" placeholder="optional" />
      </div>
    </div>
    <label>Check-in notes</label>
    <textarea id="notes" placeholder="Anything notable today…"></textarea>
    <label style="margin-top:0.75rem">&nbsp;</label>
    <button type="button" id="btnCheckin">Log daily check-in</button>
  </div>

  <div class="card">
    <label>Week label (e.g. 2026-W17)</label>
    <input id="week" placeholder="optional" />
    <label>What did you do differently this week?</label>
    <textarea id="changed"></textarea>
    <div class="row">
      <div>
        <label>Wins</label>
        <textarea id="wins"></textarea>
      </div>
      <div>
        <label>Struggles</label>
        <textarea id="struggles"></textarea>
      </div>
    </div>
    <label style="margin-top:0.75rem">&nbsp;</label>
    <button type="button" id="btnWeek">Log weekly reflection</button>
  </div>

  <div class="card">
    <div class="row">
      <div>
        <label>Series key</label>
        <input id="series" value="bmi" />
      </div>
      <div>
        <label>Value</label>
        <input id="val" type="number" step="0.01" value="28.1" />
      </div>
    </div>
    <label>Unit</label>
    <input id="unit" value="kg/m²" />
    <label style="margin-top:0.75rem">&nbsp;</label>
    <button type="button" id="btnMetric">Log clinical metric</button>
  </div>

  <div class="card">
    <label>Cost today (USD) — external sync</label>
    <input id="cost" type="number" step="0.01" placeholder="e.g. 42.50" />
    <label style="margin-top:0.75rem">&nbsp;</label>
    <button type="button" id="btnCost">Sync cost estimate</button>
  </div>

  <div class="card">
    <h2 style="font-size:1rem;margin:0 0 0.5rem">Snapshot</h2>
    <div class="grid" id="stats"></div>
    <canvas id="chart" height="180"></canvas>
    <h3 style="font-size:0.9rem;margin:1rem 0 0.25rem">Raw dashboard JSON</h3>
    <pre id="out">{}</pre>
  </div>

  <script>
    const $ = (id) => document.getElementById(id);
    async function refresh() {
      const uid = $("uid").value.trim() || "demo_user";
      const r = await fetch("/v1/users/" + encodeURIComponent(uid) + "/dashboard");
      const data = await r.json();
      $("out").textContent = JSON.stringify(data, null, 2);
      const snap = data.snapshot || {};
      const ret = snap.retention || {};
      const stats = $("stats");
      stats.innerHTML = "";
      const add = (k, v) => {
        const d = document.createElement("div");
        d.className = "stat";
        d.innerHTML = "<span>" + k + "</span><b>" + v + "</b>";
        stats.appendChild(d);
      };
      add("Check-in streak (days)", ret.checkin_streak_days ?? "—");
      add("Retention XP", ret.retention_xp ?? "—");
      add("Level", ret.retention_level ?? "—");
      add("Risk", snap.risk_level ?? "—");
      add("Adherence (model)", snap.adherence_score != null ? Math.round(snap.adherence_score * 100) + "%" : "—");

      const pts = (data.clinical_metric_timeline || []).filter((p) => p.series_key === ($("series").value || "bmi"));
      const canvas = $("chart");
      const ctx = canvas.getContext("2d");
      const w = canvas.width = canvas.clientWidth * (window.devicePixelRatio || 1);
      const h = canvas.height = 180 * (window.devicePixelRatio || 1);
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = "#94a3b8";
      ctx.lineWidth = 1 * (window.devicePixelRatio || 1);
      ctx.strokeRect(40, 10, w - 50, h - 30);
      if (pts.length < 2) {
        ctx.fillStyle = "#64748b";
        ctx.font = "12px system-ui";
        ctx.fillText("Add two or more points to see a sparkline.", 48, h / 2);
        return;
      }
      const vals = pts.map((p) => Number(p.value));
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      const pad = (max - min) * 0.1 || 1;
      const lo = min - pad;
      const hi = max + pad;
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 2 * (window.devicePixelRatio || 1);
      ctx.beginPath();
      pts.forEach((p, i) => {
        const x = 40 + (i / (pts.length - 1)) * (w - 50);
        const y = 10 + (1 - (Number(p.value) - lo) / (hi - lo)) * (h - 40);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    $("btnCheckin").onclick = async () => {
      const uid = $("uid").value.trim() || "demo_user";
      const body = { user_id: uid, notes: $("notes").value || null };
      const m = $("mood").value;
      const e = $("energy").value;
      if (m) body.mood = Number(m);
      if (e) body.energy = Number(e);
      await fetch("/v1/events/daily_checkin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      await refresh();
    };
    $("btnWeek").onclick = async () => {
      const uid = $("uid").value.trim() || "demo_user";
      await fetch("/v1/events/weekly_reflection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: uid,
          week_label: $("week").value || null,
          what_changed: $("changed").value || null,
          wins: $("wins").value || null,
          struggles: $("struggles").value || null,
        }),
      });
      await refresh();
    };
    $("btnMetric").onclick = async () => {
      const uid = $("uid").value.trim() || "demo_user";
      await fetch("/v1/events/clinical_metric", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: uid,
          series_key: $("series").value || "bmi",
          value: Number($("val").value),
          unit: $("unit").value || null,
          source_platform: "retention_ui",
        }),
      });
      await refresh();
    };
    $("btnCost").onclick = async () => {
      const uid = $("uid").value.trim() || "demo_user";
      const amt = $("cost").value;
      if (!amt) return;
      await fetch("/v1/events/external_sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: uid,
          resource_type: "cost_estimate",
          platform: "pharmacy_portal",
          payload: { amount_usd: Number(amt), label: "estimated_pay_today" },
        }),
      });
      await refresh();
    };
    $("uid").addEventListener("change", refresh);
    $("series").addEventListener("change", refresh);
    refresh();
  </script>
</body>
</html>"""
    return HTMLResponse(html)
