"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const GOALS: { value: string; label: string }[] = [
  { value: "hormones", label: "Hormone balance" },
  { value: "weight_loss", label: "Weight loss" },
  { value: "energy", label: "Energy" },
  { value: "sleep", label: "Sleep" },
  { value: "mental_health", label: "Mental health" },
];

export default function IntakeForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("hormones");
  const [symptoms, setSymptoms] = useState("");
  const [history, setHistory] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/intake", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          goal,
          symptoms: symptoms.split(",").map((s) => s.trim()).filter(Boolean),
          history,
        }),
      });
      if (!res.ok) throw new Error(`Intake failed (${res.status})`);
      const data = await res.json();
      router.push(`/care/${data.user.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label className="label">Name</label>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Alex Johnson"
          required
        />
      </div>

      <div>
        <label className="label">Primary health goal</label>
        <div className="grid grid-cols-2 gap-2">
          {GOALS.map((g) => (
            <button
              type="button"
              key={g.value}
              onClick={() => setGoal(g.value)}
              className={`btn justify-start ${
                goal === g.value
                  ? "border-luma-accent/60 bg-luma-accent/10 text-luma-accent"
                  : ""
              }`}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="label">Current symptoms (comma separated)</label>
        <input
          className="input"
          value={symptoms}
          onChange={(e) => setSymptoms(e.target.value)}
          placeholder="low energy, poor sleep, brain fog"
        />
      </div>

      <div>
        <label className="label">Brief history</label>
        <textarea
          className="input min-h-[84px]"
          value={history}
          onChange={(e) => setHistory(e.target.value)}
          placeholder="No chronic conditions. Started noticing fatigue over the past 3 months."
        />
      </div>

      {error && (
        <div className="text-xs text-luma-danger border border-luma-danger/40 bg-luma-danger/10 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      <button className="btn btn-primary w-full" disabled={submitting || !name}>
        {submitting ? "Starting care loop…" : "Start AI care loop"}
      </button>
    </form>
  );
}
