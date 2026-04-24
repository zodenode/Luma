import { ingestEvent } from "@/lib/events";
import { jsonWithRequestId, getOrCreateRequestId } from "@/lib/request-id";
import { z } from "zod";

const Body = z.object({
  userId: z.string().min(1),
  taken: z.boolean(),
  note: z.string().max(500).optional(),
});

export async function POST(req: Request) {
  const requestId = getOrCreateRequestId(req);
  const body = await req.json().catch(() => null);
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return jsonWithRequestId({ error: parsed.error.flatten() }, { requestId, status: 400 });
  }
  const type = parsed.data.taken ? "adherence_confirmed" : "adherence_missed";
  const event = await ingestEvent({
    userId: parsed.data.userId,
    type,
    source: "user",
    payload: { note: parsed.data.note ?? null },
    idempotencyKey: `log_med:${parsed.data.userId}:${type}:${Date.now()}`,
  });
  return jsonWithRequestId({ event }, { requestId });
}
