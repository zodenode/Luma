import { NextResponse } from "next/server";
import { z } from "zod";
import { ingestOpenLoopWebhook } from "@/lib/webhook-ingest";
import { verifyOpenLoopRequest } from "@/lib/webhook-auth";
import {
  badRequest,
  notFound,
  resolveUserByAny,
} from "@/lib/webhooks";

const Schema = z.object({
  event: z.enum(["consult_scheduled", "consult_completed", "prescription_issued"]),
  userId: z.string().optional(),
  openloopId: z.string().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
  idempotency_key: z.string().optional(),
});

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyOpenLoopRequest(req, raw)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

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

  const result = await ingestOpenLoopWebhook({
    userId: user.id,
    type: parsed.data.event,
    payload: parsed.data.data,
    idempotencyKey: idem,
  });

  return NextResponse.json({ ok: true, event_id: result.event_id });
}
