/* global document, fetch */

function uid() {
  return document.getElementById("userId").value.trim() || "demo_user";
}

function pretty(obj) {
  return JSON.stringify(obj, null, 2);
}

async function refreshState() {
  const id = uid();
  const res = await fetch(`/v1/users/${encodeURIComponent(id)}/state`);
  const data = await res.json();
  document.getElementById("stateOut").textContent = pretty(data);

  const ret = data.retention || {};
  const dc = ret.daily_checkin || {};
  const gm = ret.gamification || {};
  const prog = ret.program || {};

  document.getElementById("streak").textContent =
    dc.streak_current != null ? String(dc.streak_current) : "—";
  document.getElementById("level").textContent =
    gm.level != null && gm.engagement_points != null
      ? `${gm.level} / ${gm.engagement_points}`
      : "—";
  document.getElementById("week").textContent =
    prog.week_number_estimated != null ? String(prog.week_number_estimated) : "—";

  const badgeHost = document.getElementById("badges");
  badgeHost.innerHTML = "";
  (gm.badges || []).forEach((b) => {
    const el = document.createElement("span");
    el.className = "badge";
    el.textContent = b;
    badgeHost.appendChild(el);
  });

  drawSeriesChart(ret.longitudinal && ret.longitudinal.series ? ret.longitudinal.series : {});
}

function drawSeriesChart(series) {
  const canvas = document.getElementById("seriesChart");
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0c1014";
  ctx.fillRect(0, 0, w, h);

  const keys = Object.keys(series);
  if (!keys.length) {
    ctx.fillStyle = "#9aa7b2";
    ctx.font = "14px system-ui";
    ctx.fillText("Log numeric metrics to see trajectories.", 16, h / 2);
    return;
  }

  const palette = ["#5ad4a4", "#6aa7ff", "#ffb86b", "#ff7ab6", "#c3a6ff"];
  let idx = 0;
  keys.forEach((metricId) => {
    const pts = (series[metricId] && series[metricId].points) || [];
    const values = pts
      .map((p) => Number(p.value))
      .filter((v) => Number.isFinite(v));
    if (values.length < 2) {
      idx += 1;
      return;
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const pad = 24;
    const color = palette[idx % palette.length];
    idx += 1;

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = pad + (i / (values.length - 1)) * (w - pad * 2);
      const t = max === min ? 0.5 : (v - min) / (max - min);
      const y = h - pad - t * (h - pad * 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.font = "12px system-ui";
    ctx.fillText(metricId, pad, 18 + idx * 14);
  });
}

async function postJson(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || res.statusText);
  }
  return res.json();
}

document.getElementById("refreshState").addEventListener("click", refreshState);

document.getElementById("formDaily").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const mood = fd.get("mood");
  const energy = fd.get("energy");
  await postJson("/v1/events/daily_checkin", {
    user_id: uid(),
    mood_1_5: mood ? Number(mood) : null,
    energy_1_5: energy ? Number(energy) : null,
    note: fd.get("note") || null,
  });
  await refreshState();
});

document.getElementById("formWeekly").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const wn = fd.get("week_number");
  await postJson("/v1/events/weekly_reflection", {
    user_id: uid(),
    what_changed: fd.get("what_changed"),
    challenges: fd.get("challenges") || null,
    week_number: wn ? Number(wn) : null,
  });
  await refreshState();
});

document.getElementById("formMetric").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const raw = fd.get("value");
  let value = raw;
  const num = Number(raw);
  if (String(raw).trim() !== "" && Number.isFinite(num)) value = num;
  await postJson("/v1/events/metric", {
    user_id: uid(),
    metric_id: fd.get("metric_id"),
    value,
    unit: fd.get("unit") || null,
    source: fd.get("source") || null,
  });
  await refreshState();
});

document.getElementById("formCost").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const amt = fd.get("amount_today");
  await postJson("/v1/events/cost_barrier", {
    user_id: uid(),
    amount_today: amt === "" || amt == null ? null : Number(amt),
    currency: fd.get("currency") || null,
    reason: fd.get("reason") || null,
  });
  await refreshState();
});

refreshState().catch((err) => {
  document.getElementById("stateOut").textContent = String(err);
});
