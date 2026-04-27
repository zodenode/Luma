import clsx from "clsx";
import type { TreatmentState, User } from "@/lib/types";

export default function CareContextCard({
  user,
  treatment,
  memoryUpdatedAt,
}: {
  user: User;
  treatment?: TreatmentState;
  memoryUpdatedAt?: string;
}) {
  const stage = treatment?.stage ?? "intake";
  const focus =
    treatment?.key_symptoms?.length ?
      treatment.key_symptoms.slice(0, 3).join(", ")
    : user.symptoms.slice(0, 3).join(", ") || "—";

  return (
    <div className="card p-4 border-l-4 border-luma-accent/60">
      <div className="text-xs uppercase tracking-wide text-luma-muted">Care context</div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div>
          <div className="text-[11px] text-luma-muted">Treatment status</div>
          <div className="text-sm font-medium capitalize">{stage.replace(/_/g, " ")}</div>
        </div>
        <div>
          <div className="text-[11px] text-luma-muted">Focus areas</div>
          <div className="text-sm">{focus}</div>
        </div>
        <div>
          <div className="text-[11px] text-luma-muted">Last update</div>
          <div className="text-xs font-mono">
            {memoryUpdatedAt
              ? new Date(memoryUpdatedAt).toLocaleString()
              : treatment?.updated_at
                ? new Date(treatment.updated_at).toLocaleString()
                : "—"}
          </div>
        </div>
        <div>
          <div className="text-[11px] text-luma-muted">Next action</div>
          <div className={clsx("text-sm", !treatment?.next_recommended_action && "text-luma-muted")}>
            {treatment?.next_recommended_action ?? "Complete intake and schedule your consult."}
          </div>
        </div>
      </div>
    </div>
  );
}
