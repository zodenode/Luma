import { NextResponse } from "next/server";
import { z } from "zod";
import { ingestEvent } from "@/lib/events";
import { getRequestId, withRequestIdHeaders } from "@/lib/requestContext";

const Schema = z.object({
  userId: z.string().min(1),
  reason: z.string().max(500).optional(),
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
  const idem = parsed.data.idempotency_key ?? `request_help:${parsed.data.userId}:${requestId}`;
  const event = await ingestEvent({
    userId: parsed.data.userId,
    type: "request_help",
    source: "user",
    payload: { reason: parsed.data.reason ?? "User requested human help" },
    idempotency_key: idem,
  });
  return withRequestIdHeaders(NextResponse.json({ event }), requestId);
}
