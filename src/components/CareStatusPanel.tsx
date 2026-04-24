import clsx from "clsx";
import type { TreatmentState, User } from "@/lib/types";

const STAGE_LABEL: Record<TreatmentState["stage"], string> = {
  intake: "Intake in progress",
  pre_consult: "Awaiting consult",
  post_consult: "Post-consult",
  awaiting_fulfilment: "Awaiting medication",
  active_treatment: "Active treatment",
  paused: "Paused",
  escalated: "Clinician review",
};

const MED_LABEL: Record<string, string> = {
  none: "No medication",
  not_started: "Prescribed · not started",
  shipped: "Shipped",
  delivered: "Delivered",
  active: "Active",
  refill_due: "Refill due",
};

export default function CareStatusPanel({
  user,
  treatment,
}: {
  user: User;
  treatment?: TreatmentState;
}) {
  const stage = treatment?.stage ?? "intake";
  const med = treatment?.medication;
  const adherence = treatment?.adherence_score;
  const adherencePct = adherence != null ? Math.round(adherence * 100) : null;
  const riskFlags = treatment?.risk_flags ?? [];

  return (
    <div className="card p-4">
      <div className="text-xs uppercase tracking-wide text-luma-muted">Care status</div>
      <div className="mt-3 flex items-center gap-2">
        <span
          className={clsx(
            "chip",
            stage === "active_treatment" && "border-luma-accent/50 text-luma-accent bg-luma-accent/10",
            stage === "escalated" && "border-luma-danger/60 text-luma-danger bg-luma-danger/10",
            stage !== "active_treatment" &&
              stage !== "escalated" &&
              "border-luma-border text-luma-muted",
          )}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-current" />
          {STAGE_LABEL[stage]}
        </span>
      </div>

      <div className="mt-4 space-y-3">
        <Row label="Goal" value={user.goal.replace("_", " ")} />
        <Row label="OpenLoop ID" value={user.linked_openloop_id ?? "—"} mono />
        <Row
          label="Medication"
          value={
            med
              ? `${med.name}${med.dosage ? ` · ${med.dosage}` : ""}`
              : "Not prescribed yet"
          }
        />
        <Row label="State" value={med ? MED_LABEL[med.state] ?? med.state : "—"} />
        {treatment?.adherence_indicator && treatment.adherence_indicator !== "unknown" && (
          <Row label="Adherence signal" value={treatment.adherence_indicator.replace(/_/g, " ")} />
        )}
        {adherencePct != null && (
          <div>
            <div className="text-xs text-luma-muted mb-1">Adherence</div>
            <div className="h-1.5 rounded-full bg-luma-border overflow-hidden">
              <div
                className={clsx(
                  "h-full rounded-full",
                  adherencePct >= 70
                    ? "bg-luma-accent"
                    : adherencePct >= 40
                    ? "bg-luma-warn"
                    : "bg-luma-danger",
                )}
                style={{ width: `${adherencePct}%` }}
              />
            </div>
            <div className="text-xs text-luma-muted mt-1">{adherencePct}%</div>
          </div>
        )}
      </div>

      {treatment?.next_recommended_action && (
        <div className="mt-4 p-3 rounded-lg border border-luma-accent/30 bg-luma-accent/5">
          <div className="text-[10px] uppercase tracking-wide text-luma-accent font-medium">
            Next action
          </div>
          <div className="text-sm mt-1">{treatment.next_recommended_action}</div>
        </div>
      )}

      {riskFlags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {riskFlags.map((flag) => (
            <span
              key={flag}
              className="chip border-luma-danger/50 text-luma-danger bg-luma-danger/10"
            >
              {flag.replace(/_/g, " ")}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="text-xs text-luma-muted">{label}</div>
      <div className={clsx("text-sm text-right", mono && "font-mono text-xs")}>
        {value}
      </div>
    </div>
  );
}
