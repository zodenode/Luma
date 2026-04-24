import { NextResponse } from "next/server";
import { z } from "zod";
import { ingestEvent } from "@/lib/events";
import { getRequestId, withRequestIdHeaders } from "@/lib/requestContext";

const Schema = z.object({
  userId: z.string().min(1),
  taken: z.boolean(),
  note: z.string().max(500).optional(),
  idempotency_key: z.string().max(200).optional(),
});

export async function POST(req: Request) {
  const requestId = getRequestId(req);
  const body = await req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return withRequestIdHeaders(
      NextResponse.json({ error: parsed.error.flatten() }, { status: 400 }),
      requestId,
    );
  }
  const idem =
    parsed.data.idempotency_key ??
    `log_med:${parsed.data.userId}:${parsed.data.taken}:${Date.now()}`;
  const event = await ingestEvent({
    userId: parsed.data.userId,
    type: parsed.data.taken ? "adherence_confirmed" : "adherence_missed",
    source: "user",
    payload: { note: parsed.data.note ?? null },
    idempotency_key: idem,
  });
  return withRequestIdHeaders(NextResponse.json({ event }), requestId);
}
