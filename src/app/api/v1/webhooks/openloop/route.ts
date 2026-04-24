import { z } from "zod";
import { ingestEvent } from "@/lib/events";
import { badRequest, notFound, resolveUserByAny } from "@/lib/webhooks";
import { jsonOk } from "@/lib/v1";
import { stableIdempotencyKey, verifyWebhookHmac, webhookUnauthorized } from "@/lib/webhookSecurity";
import { getOrCreateRequestId, logLine } from "@/lib/requestContext";

const Schema = z.object({
  event: z.enum(["consult_scheduled", "consult_completed", "prescription_issued"]),
  userId: z.string().optional(),
  openloopId: z.string().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
  idempotency_key: z.string().optional(),
});

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const requestId = getOrCreateRequestId(req);
  const raw = await req.text();
  const sig =
    req.headers.get("x-signature") ??
    req.headers.get("x-hub-signature-256") ??
    req.headers.get("x-openloop-signature");

  if (
    !verifyWebhookHmac(
      raw,
      sig,
      process.env.OPENLOOP_WEBHOOK_HMAC_SECRET ?? process.env.OPENLOOP_WEBHOOK_SECRET,
    )
  ) {
    return webhookUnauthorized();
  }

  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    return badRequest("invalid_json");
  }

  const parsed = Schema.safeParse(body);
  if (!parsed.success) return badRequest("Invalid webhook payload");

  const user = await resolveUserByAny({
    userId: parsed.data.userId,
    openloopId: parsed.data.openloopId,
  });
  if (!user) return notFound("user_not_found");

  const idem =
    parsed.data.idempotency_key?.trim() ||
    stableIdempotencyKey(["openloop", parsed.data.event, user.id, JSON.stringify(parsed.data.data)]);

  const event = await ingestEvent({
    userId: user.id,
    type: parsed.data.event,
    source: "openloop",
    payload: parsed.data.data,
    idempotency_key: idem,
  });

  logLine("info", requestId, "webhook_openloop", { event_id: event.id, userId: user.id });
  return jsonOk(req, { ok: true, event_id: event.id });
}
