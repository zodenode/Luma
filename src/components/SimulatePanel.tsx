"use client";

import { useState } from "react";

const EVENTS: { value: string; label: string; source: string }[] = [
  { value: "consult_completed", label: "Consult completed", source: "OpenLoop" },
  { value: "prescription_issued", label: "Prescription issued", source: "OpenLoop" },
  { value: "medication_shipped", label: "Medication shipped", source: "Pharmacy" },
  { value: "medication_delivered", label: "Medication delivered", source: "Pharmacy" },
  { value: "refill_due", label: "Refill due", source: "Pharmacy" },
  { value: "adherence_missed", label: "Adherence missed", source: "System" },
];

export default function SimulatePanel({
  onSimulate,
  busy,
}: {
  onSimulate: (event: string) => Promise<void> | void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button className="btn btn-ghost text-xs" onClick={() => setOpen((v) => !v)}>
        ⚡ Simulate event
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-72 card p-2 z-50">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-luma-muted">
            Trigger external event
          </div>
          <ul className="divide-y divide-luma-border">
            {EVENTS.map((e) => (
              <li key={e.value}>
                <button
                  disabled={busy}
                  className="w-full text-left px-2 py-2 hover:bg-luma-surface rounded-md flex items-center justify-between text-sm disabled:opacity-50"
                  onClick={async () => {
                    await onSimulate(e.value);
                    setOpen(false);
                  }}
                >
                  <span>{e.label}</span>
                  <span className="text-[10px] text-luma-muted">{e.source}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
