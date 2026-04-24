import { z } from "zod";
import { runSummarisation } from "@/lib/chat";
import { jsonError, jsonOk } from "@/lib/v1";
import { getOrCreateRequestId, logLine } from "@/lib/requestContext";

const Schema = z.object({
  userId: z.string().min(1),
});

export const dynamic = "force-dynamic";

/** POST /v1/chat/summarise — memory maintenance (plan §6.3). */
export async function POST(req: Request) {
  const requestId = getOrCreateRequestId(req);
  const body = await req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return jsonError(req, 400, "invalid_body");

  const result = await runSummarisation(parsed.data.userId);
  if (!result) return jsonError(req, 400, "nothing_to_summarise");

  logLine("info", requestId, "conversation_summarised", {
    userId: parsed.data.userId,
    snapshot_id: result.snapshot_id,
  });

  return jsonOk(req, { summary: result.summary, snapshot_id: result.snapshot_id });
}
