import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyWebhookHmac } from "@/lib/hmac";
import { processOpenLoopWebhook } from "@/lib/webhookIngress";
import { getRequestId, withRequestIdHeaders } from "@/lib/requestContext";
import type { EventType } from "@/lib/types";

const BodySchema = z.object({
  event: z.enum(["consult_scheduled", "consult_completed", "prescription_issued"]),
  userId: z.string().optional(),
  openloopId: z.string().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
  idempotency_key: z.string().optional(),
});

export async function POST(req: Request) {
  const requestId = getRequestId(req);
  const raw = await req.text();
  const secret = process.env.OPENLOOP_WEBHOOK_HMAC_SECRET ?? process.env.WEBHOOK_HMAC_SECRET;
  const sig = req.headers.get("x-signature") ?? req.headers.get("x-hub-signature-256");
  if (!verifyWebhookHmac(raw, sig, secret)) {
    return withRequestIdHeaders(NextResponse.json({ error: "unauthorized" }, { status: 401 }), requestId);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return withRequestIdHeaders(NextResponse.json({ error: "invalid_json" }, { status: 400 }), requestId);
  }

  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return withRequestIdHeaders(
      NextResponse.json({ error: parsed.error.flatten() }, { status: 400 }),
      requestId,
    );
  }

  const idem =
    req.headers.get("idempotency-key")?.trim() ||
    parsed.data.idempotency_key ||
    `openloop:${parsed.data.event}:${parsed.data.userId ?? parsed.data.openloopId ?? "unknown"}:${requestId}`;

  const result = await processOpenLoopWebhook({
    event: parsed.data.event as EventType,
    userId: parsed.data.userId,
    openloopId: parsed.data.openloopId,
    data: parsed.data.data,
    idempotencyKey: idem,
  });

  if (!result.ok) {
    return withRequestIdHeaders(
      NextResponse.json({ error: result.error }, { status: result.status }),
      requestId,
    );
  }
  return withRequestIdHeaders(
    NextResponse.json({ ok: true, event_id: result.event_id }),
    requestId,
  );
}
