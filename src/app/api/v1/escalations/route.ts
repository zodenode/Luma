import { listEscalations } from "@/lib/store";
import { jsonOk } from "@/lib/v1";

export const dynamic = "force-dynamic";

/** Clinician escalation queue (MVP list). */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const status = url.searchParams.get("status") as "open" | "acknowledged" | "closed" | null;
  const userId = url.searchParams.get("userId")?.trim();
  const list = await listEscalations({
    status: status ?? undefined,
    userId: userId || undefined,
  });
  return jsonOk(req, { escalations: list });
}
