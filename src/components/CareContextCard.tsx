"use client";

import clsx from "clsx";
import type { TreatmentState, User } from "@/lib/types";

export default function CareContextCard({
  user,
  treatment,
}: {
  user: User;
  treatment?: TreatmentState;
}) {
  const focus =
    treatment?.focus_areas?.length ?
      treatment.focus_areas
    : [user.goal.replace("_", " "), "symptom tracking", "medication routine"].slice(0, 3);

  return (
    <div className="card p-4 border-l-4 border-luma-accent/60">
      <div className="text-xs uppercase tracking-wide text-luma-muted">Care context</div>
      <div className="mt-2 text-sm font-medium">{user.name}</div>
      <div className="text-xs text-luma-muted mt-1">
        Last update:{" "}
        {treatment?.last_interaction_at || treatment?.updated_at ?
          formatRelative(treatment.last_interaction_at ?? treatment.updated_at)
        : "—"}
      </div>
      <div className="mt-3">
        <div className="text-[10px] uppercase text-luma-muted mb-1">Focus areas</div>
        <div className="flex flex-wrap gap-1.5">
          {focus.map((f) => (
            <span key={f} className={clsx("chip border-luma-border text-luma-muted text-xs")}>
              {f}
            </span>
          ))}
        </div>
      </div>
      {treatment?.next_recommended_action && (
        <div className="mt-3 text-xs text-luma-muted">
          <span className="text-luma-accent font-medium">Next: </span>
          {treatment.next_recommended_action}
        </div>
      )}
    </div>
  );
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
