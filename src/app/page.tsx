import Link from "next/link";
import { listUsers } from "@/lib/store";
import IntakeForm from "@/components/IntakeForm";

export const dynamic = "force-dynamic";

export default async function Home() {
  const users = await listUsers();

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="flex items-center justify-between mb-10">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-luma-accent/20 border border-luma-accent/40 grid place-items-center">
            <span className="text-luma-accent font-semibold">L</span>
          </div>
          <div>
            <h1 className="text-lg font-semibold leading-none">Luma</h1>
            <p className="text-xs text-luma-muted">AI coaching for telehealth</p>
          </div>
        </div>
        <div className="text-xs text-luma-muted">MVP · OpenLoop wrapper</div>
      </header>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div>
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">
            A continuous AI coach for every clinical event.
          </h2>
          <p className="mt-4 text-luma-muted leading-relaxed">
            Luma sits on top of your telehealth consult and pharmacy fulfilment.
            Every consult outcome, prescription update, and check-in triggers
            an AI-driven follow-up — so retention and adherence happen by
            default, not by reminder.
          </p>
          <ul className="mt-6 space-y-2 text-sm text-luma-muted">
            <li>· Chat-first coach, grounded in your plan + medication state</li>
            <li>· Care status, timeline, and quick actions always visible</li>
            <li>· Webhook ingestion for OpenLoop and pharmacy events</li>
            <li>· Automatic clinical escalation on risk signals</li>
          </ul>

          {users.length > 0 && (
            <div className="mt-8 card p-4">
              <div className="text-xs uppercase tracking-wide text-luma-muted mb-3">
                Existing patients
              </div>
              <ul className="divide-y divide-luma-border">
                {users.map((u) => (
                  <li key={u.id} className="py-2 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium">{u.name}</div>
                      <div className="text-xs text-luma-muted">
                        Goal: {u.goal.replace("_", " ")}
                      </div>
                    </div>
                    <Link className="btn btn-ghost text-luma-accent" href={`/care/${u.id}`}>
                      Open →
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="card p-6">
          <h3 className="text-lg font-semibold">Start intake</h3>
          <p className="text-sm text-luma-muted mt-1">
            This mirrors Step 1 of the care journey. After submitting you'll land
            in the AI Care Loop for that patient.
          </p>
          <div className="mt-6">
            <IntakeForm />
          </div>
        </div>
      </section>
    </main>
  );
}
