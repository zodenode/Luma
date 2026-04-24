import { readDB } from "@/lib/store";
import { jsonError, jsonOk, requireUserId } from "@/lib/v1";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const userId = requireUserId(req);
  if (!userId) return jsonError(req, 400, "missing_user_id");

  const db = await readDB();
  const kpis = db.kpi_events.filter((k) => k.user_id === userId);
  return jsonOk(req, { kpi_events: kpis });
}
