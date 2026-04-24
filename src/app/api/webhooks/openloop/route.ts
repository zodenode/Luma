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
  event: z.enum(["consult_scheduled", "consult_completed", "prescription_issued"]),
  userId: z.string().optional(),
  openloopId: z.string().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});

export async function POST(req: Request) {
  if (!verifySecret(req, "OPENLOOP_WEBHOOK_SECRET")) return unauthorized();

  const body = await req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return badRequest("Invalid webhook payload");

  const user = await resolveUserByAny({
    userId: parsed.data.userId,
    openloopId: parsed.data.openloopId,
  });
  if (!user) return notFound("user_not_found");

  const event = await ingestEvent({
    userId: user.id,
    type: parsed.data.event,
    source: "openloop",
    payload: parsed.data.data,
  });

  return NextResponse.json({ ok: true, event_id: event.id });
}
