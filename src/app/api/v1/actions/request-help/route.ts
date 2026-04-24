import { ingestEvent } from "@/lib/events";
import { jsonWithRequestId, getOrCreateRequestId } from "@/lib/request-id";
import { z } from "zod";

const Body = z.object({
  userId: z.string().min(1),
  reason: z.string().max(500).optional(),
});

export async function POST(req: Request) {
  const requestId = getOrCreateRequestId(req);
  const body = await req.json().catch(() => null);
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return jsonWithRequestId({ error: parsed.error.flatten() }, { requestId, status: 400 });
  }
  const event = await ingestEvent({
    userId: parsed.data.userId,
    type: "request_help",
    source: "user",
    payload: { reason: parsed.data.reason ?? "User requested human help" },
    idempotencyKey: `request_help:${parsed.data.userId}:${Date.now()}`,
  });
  return jsonWithRequestId({ event }, { requestId });
}
