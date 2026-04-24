import { z } from "zod";
import { ingestEvent } from "@/lib/events";
import { jsonError, jsonOk } from "@/lib/v1";
import { getOrCreateRequestId, logLine } from "@/lib/requestContext";

const Schema = z.object({
  userId: z.string().min(1),
  taken: z.boolean(),
  note: z.string().max(500).optional(),
});

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const requestId = getOrCreateRequestId(req);
  const body = await req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return jsonError(req, 400, "invalid_body");

  const type = parsed.data.taken ? "user_checkin" : "adherence_missed";
  const event = await ingestEvent({
    userId: parsed.data.userId,
    type,
    source: "user",
    payload: {
      adherence_log: true,
      taken: parsed.data.taken,
      note: parsed.data.note ?? null,
    },
    idempotency_key: `log_med:${parsed.data.userId}:${Date.now()}`,
  });

  logLine("info", requestId, "action_log_medication", { userId: parsed.data.userId, type });
  return jsonOk(req, { event });
}
