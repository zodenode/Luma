import { NextResponse } from "next/server";
import { z } from "zod";
import { ingestEvent } from "@/lib/events";
import {
  badRequest,
  notFound,
  resolveUserByAny,
  unauthorized,
} from "@/lib/webhooks";
import { verifyOpenLoopRequest } from "@/lib/webhook-auth";

const Schema = z.object({
  event: z.enum(["consult_scheduled", "consult_completed", "prescription_issued"]),
  userId: z.string().optional(),
  openloopId: z.string().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
  idempotency_key: z.string().optional(),
});

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyOpenLoopRequest(req, raw)) return unauthorized();

  let body: unknown;
  try {
    body = JSON.parse(raw);
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
    parsed.data.idempotency_key ??
    `openloop:${parsed.data.event}:${parsed.data.userId ?? parsed.data.openloopId ?? user.id}`;

  const event = await ingestEvent({
    userId: user.id,
    type: parsed.data.event,
    source: "openloop",
    payload: parsed.data.data,
    idempotencyKey: idem,
  });

  return NextResponse.json({ ok: true, event_id: event.id });
}
