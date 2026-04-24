import clsx from "clsx";
import type { TreatmentState, User } from "@/lib/types";

const STAGE_LABEL: Record<TreatmentState["stage"], string> = {
  pre_consult: "Pre-consult",
  post_consult: "Post-consult",
  active_treatment: "Active treatment",
};

const MED_LABEL: Record<TreatmentState["medication_status"], string> = {
  none: "No medication",
  prescribed: "Prescribed",
  shipped: "Shipped",
  active: "Active",
};

const ADH_LABEL: Record<TreatmentState["adherence_indicator"], string> = {
  unknown: "Unknown",
  good: "On track",
  at_risk: "At risk",
};

export default function CareStatusPanel({
  user,
  treatment,
}: {
  user: User;
  treatment?: TreatmentState;
}) {
  const stage = treatment?.stage ?? "pre_consult";
  const med = treatment?.active_medication;
  const adherence = treatment?.adherence_score;
  const adherencePct = adherence != null ? Math.round(adherence * 100) : null;

  return (
    <div className="card p-4">
      <div className="text-xs uppercase tracking-wide text-luma-muted">Care status</div>
      <div className="mt-3 flex items-center gap-2">
        <span
          className={clsx(
            "chip",
            stage === "active_treatment" && "border-luma-accent/50 text-luma-accent bg-luma-accent/10",
            stage !== "active_treatment" && "border-luma-border text-luma-muted",
          )}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-current" />
          {STAGE_LABEL[stage]}
        </span>
        <span className="chip border-luma-border text-luma-muted text-[10px]">
          {ADH_LABEL[treatment?.adherence_indicator ?? "unknown"]}
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
        <Row label="Fulfillment" value={MED_LABEL[treatment?.medication_status ?? "none"]} />
        {adherencePct != null && (
          <div>
            <div className="text-xs text-luma-muted mb-1">Adherence score</div>
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
