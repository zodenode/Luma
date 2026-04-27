import { NextResponse } from "next/server";
import { z } from "zod";
import { ingestEvent } from "@/lib/events";
import {
  badRequest,
  notFound,
  resolveUserByAny,
  unauthorized,
  verifySecret,
} from "@/lib/webhooks";

const Schema = z.object({
  event: z.enum(["medication_shipped", "medication_delivered", "refill_due"]),
  userId: z.string().optional(),
  openloopId: z.string().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});

export async function POST(req: Request) {
  if (!verifySecret(req, "PHARMACY_WEBHOOK_SECRET")) return unauthorized();

  const body = await req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return badRequest("Invalid webhook payload");

  const user = await resolveUserByAny({
    userId: parsed.data.userId,
    openloopId: parsed.data.openloopId,
  });
  if (!user) return notFound("user_not_found");

  const idem =
    req.headers.get("idempotency-key")?.trim() ||
    `pharmacy:legacy:${parsed.data.event}:${user.id}:${JSON.stringify(parsed.data.data).slice(0, 80)}`;

  const event = await ingestEvent({
    userId: user.id,
    type: parsed.data.event,
    source: "pharmacy",
    payload: parsed.data.data,
    idempotency_key: idem,
  });

  return NextResponse.json({ ok: true, event_id: event.id });
}
