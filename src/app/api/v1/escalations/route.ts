import { listEscalations } from "@/lib/store";
import { jsonWithRequestId, getOrCreateRequestId } from "@/lib/request-id";
import { z } from "zod";

export const dynamic = "force-dynamic";

const Query = z.object({
  status: z.enum(["open", "acknowledged", "closed"]).optional(),
});

/** Clinician escalation queue (plan §3.2 #6) */
export async function GET(req: Request) {
  const requestId = getOrCreateRequestId(req);
  const url = new URL(req.url);
  const parsed = Query.safeParse({ status: url.searchParams.get("status") ?? undefined });
  if (!parsed.success) {
    return jsonWithRequestId({ error: parsed.error.flatten() }, { requestId, status: 400 });
  }
  const items = await listEscalations(parsed.data.status);
  return jsonWithRequestId({ escalations: items }, { requestId });
}
