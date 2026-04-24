"use client";

import { useState } from "react";
import type { TreatmentState } from "@/lib/types";

interface Props {
  userId: string;
  treatment?: TreatmentState;
  onAction: (path: string, body: Record<string, unknown>) => Promise<void> | void;
  onOpenChat: (text: string) => void;
  busy: boolean;
}

export default function QuickActionsBar({
  userId,
  treatment,
  onAction,
  onOpenChat,
  busy,
}: Props) {
  const [symptomOpen, setSymptomOpen] = useState(false);
  const hasMed =
    Boolean(treatment?.active_medication) &&
    treatment?.medication_status !== "none";

  return (
    <div className="card p-3 flex flex-wrap gap-2 items-center">
      <span className="text-xs uppercase tracking-wide text-luma-muted mr-2 ml-1">
        Quick actions
      </span>
      <button
        className="btn"
        disabled={busy}
        onClick={() =>
          onAction("/api/v1/actions/checkin", { userId, note: "Quick check-in" })
        }
      >
        ✓ Check in
      </button>
      <button
        className="btn"
        disabled={busy || !hasMed}
        onClick={() =>
          onAction("/api/v1/actions/log-medication", { userId, taken: true })
        }
      >
        ✅ Log dose taken
      </button>
      <button
        className="btn"
        disabled={busy || !hasMed}
        onClick={() =>
          onAction("/api/v1/actions/log-medication", { userId, taken: false })
        }
      >
        ⏭️ Missed dose
      </button>
      <button className="btn" disabled={busy} onClick={() => setSymptomOpen((v) => !v)}>
        📝 Check-in symptom
      </button>
      <button
        className="btn"
        disabled={busy}
        onClick={() => onOpenChat("Can you explain my treatment plan in simple terms?")}
      >
        💬 Ask AI about my plan
      </button>
      <button
        className="btn text-luma-warn"
        disabled={busy}
        onClick={() =>
          onAction("/api/v1/actions/request-help", {
            userId,
            reason: "User requested human help",
          })
        }
      >
        🆘 Request help
      </button>

      {symptomOpen && (
        <SymptomForm
          onCancel={() => setSymptomOpen(false)}
          busy={busy}
          onSubmit={async (symptom, severity, note) => {
            await onAction("/api/v1/actions/checkin", {
              userId,
              symptom,
              severity,
              note,
            });
            setSymptomOpen(false);
          }}
        />
      )}
    </div>
  );
}

function SymptomForm({
  onSubmit,
  onCancel,
  busy,
}: {
  onSubmit: (symptom: string, severity: number, note?: string) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [symptom, setSymptom] = useState("");
  const [severity, setSeverity] = useState(3);
  const [note, setNote] = useState("");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!symptom.trim()) return;
        onSubmit(symptom.trim(), severity, note.trim() || undefined);
      }}
      className="w-full mt-2 grid grid-cols-1 md:grid-cols-[1fr_140px_1fr_auto_auto] gap-2 items-end"
    >
      <div>
        <label className="label">Symptom</label>
        <input
          className="input"
          placeholder="headache, nausea, mood, sleep…"
          value={symptom}
          onChange={(e) => setSymptom(e.target.value)}
          required
        />
      </div>
      <div>
        <label className="label">Severity ({severity}/10)</label>
        <input
          type="range"
          min={0}
          max={10}
          value={severity}
          onChange={(e) => setSeverity(Number(e.target.value))}
          className="w-full"
        />
      </div>
      <div>
        <label className="label">Note (optional)</label>
        <input
          className="input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Started after breakfast"
        />
      </div>
      <button className="btn btn-primary" disabled={busy || !symptom.trim()}>
        Submit
      </button>
      <button type="button" className="btn btn-ghost" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}
