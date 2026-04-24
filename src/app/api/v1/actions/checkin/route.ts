import { ingestEvent } from "@/lib/events";
import { jsonWithRequestId, getOrCreateRequestId } from "@/lib/request-id";
import { z } from "zod";

const Body = z.object({
  userId: z.string().min(1),
  note: z.string().max(500).optional(),
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
    type: "user_checkin",
    source: "user",
    payload: { note: parsed.data.note ?? null, channel: "checkin_endpoint" },
    idempotencyKey: `checkin:${parsed.data.userId}:${Date.now()}`,
  });
  return jsonWithRequestId({ event }, { requestId });
}
