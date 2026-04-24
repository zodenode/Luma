import type { ConversationMemory, MemorySnapshot, TreatmentState, User } from "@/lib/types";

export default function CareContextCard({
  user,
  treatment,
  memory,
  snapshot,
}: {
  user: User;
  treatment?: TreatmentState;
  memory?: ConversationMemory;
  snapshot?: MemorySnapshot;
}) {
  const stage = treatment?.stage ?? "pre_consult";
  const focus = treatment?.next_recommended_action ?? "Complete intake and schedule your consult.";
  const threads = memory?.open_threads?.length
    ? memory.open_threads
    : snapshot?.open_threads ?? [];
  const summaryPreview = (memory?.summary || snapshot?.summary || "").slice(0, 220);
  const lastUpdate = memory?.updated_at ?? snapshot?.created_at ?? treatment?.updated_at;

  return (
    <div className="card p-4 border-luma-accent/25 bg-gradient-to-br from-luma-accent/5 to-transparent">
      <div className="text-[10px] uppercase tracking-wide text-luma-accent font-medium">
        Pinned context
      </div>
      <div className="mt-2 text-sm font-medium">{user.name}</div>
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
        <div>
          <div className="text-luma-muted">Treatment stage</div>
          <div className="text-sm mt-0.5 capitalize">{stage.replace(/_/g, " ")}</div>
        </div>
        <div>
          <div className="text-luma-muted">Medication status</div>
          <div className="text-sm mt-0.5 capitalize">
            {treatment?.medication_status?.replace(/_/g, " ") ?? "none"}
          </div>
        </div>
      </div>
      <div className="mt-3">
        <div className="text-luma-muted text-xs">Focus / next action</div>
        <div className="text-sm mt-1 leading-relaxed">{focus}</div>
      </div>
      {threads.length > 0 && (
        <div className="mt-3">
          <div className="text-luma-muted text-xs">Open threads</div>
          <ul className="mt-1 space-y-1 text-sm list-disc list-inside text-luma-muted">
            {threads.slice(0, 3).map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>
      )}
      {summaryPreview && (
        <div className="mt-3 text-xs text-luma-muted leading-relaxed border-t border-luma-border pt-3">
          <span className="text-luma-muted">Memory: </span>
          {summaryPreview}
          {(memory?.summary || snapshot?.summary || "").length > 220 ? "…" : ""}
        </div>
      )}
      {lastUpdate && (
        <div className="mt-2 text-[10px] text-luma-muted">
          Last update · {new Date(lastUpdate).toLocaleString()}
        </div>
      )}
    </div>
  );
}
