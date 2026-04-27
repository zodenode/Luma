import { ingestEvent } from "./events";
import { appendAuditLog } from "./store";
import { resolveUserByAny } from "./webhooks";
import type { EventType } from "./types";

export async function processOpenLoopWebhook(args: {
  event: EventType;
  userId?: string;
  openloopId?: string;
  data: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<{ ok: true; event_id: string } | { ok: false; error: string; status: number }> {
  const user = await resolveUserByAny({
    userId: args.userId,
    openloopId: args.openloopId,
  });
  if (!user) return { ok: false, error: "user_not_found", status: 404 };

  const allowed: EventType[] = ["consult_scheduled", "consult_completed", "prescription_issued"];
  if (!allowed.includes(args.event)) {
    return { ok: false, error: "invalid_event", status: 400 };
  }

  await appendAuditLog({
    action: "webhook_received",
    user_id: user.id,
    resource_type: "webhook",
    resource_id: args.idempotencyKey,
    detail: { provider: "openloop", event: args.event },
  });

  const event = await ingestEvent({
    userId: user.id,
    type: args.event,
    source: "openloop",
    payload: args.data,
    idempotency_key: args.idempotencyKey,
  });

  return { ok: true, event_id: event.id };
}

export async function processPharmacyWebhook(args: {
  event: EventType;
  userId?: string;
  openloopId?: string;
  data: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<{ ok: true; event_id: string } | { ok: false; error: string; status: number }> {
  const user = await resolveUserByAny({
    userId: args.userId,
    openloopId: args.openloopId,
  });
  if (!user) return { ok: false, error: "user_not_found", status: 404 };

  const allowed: EventType[] = ["medication_shipped", "medication_delivered", "refill_due"];
  if (!allowed.includes(args.event)) {
    return { ok: false, error: "invalid_event", status: 400 };
  }

  await appendAuditLog({
    action: "webhook_received",
    user_id: user.id,
    resource_type: "webhook",
    resource_id: args.idempotencyKey,
    detail: { provider: "pharmacy", event: args.event },
  });

  const event = await ingestEvent({
    userId: user.id,
    type: args.event,
    source: "pharmacy",
    payload: args.data,
    idempotency_key: args.idempotencyKey,
  });

  return { ok: true, event_id: event.id };
}
