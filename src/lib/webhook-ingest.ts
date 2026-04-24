import { ingestEvent } from "./events";
import type { EventType } from "./types";

export async function ingestOpenLoopWebhook(args: {
  userId: string;
  type: EventType;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<{ event_id: string }> {
  const event = await ingestEvent({
    userId: args.userId,
    type: args.type,
    source: "openloop",
    payload: args.payload,
    idempotencyKey: args.idempotencyKey,
  });
  return { event_id: event.id };
}

export async function ingestPharmacyWebhook(args: {
  userId: string;
  type: EventType;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<{ event_id: string }> {
  const event = await ingestEvent({
    userId: args.userId,
    type: args.type,
    source: "pharmacy",
    payload: args.payload,
    idempotencyKey: args.idempotencyKey,
  });
  return { event_id: event.id };
}
