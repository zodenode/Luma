import { NextResponse } from "next/server";
import { z } from "zod";
import { ingestEvent } from "@/lib/events";
import type { EventType } from "@/lib/types";

const Schema = z.object({
  userId: z.string(),
  event: z.enum([
    "consult_scheduled",
    "consult_completed",
    "prescription_issued",
    "medication_shipped",
    "medication_delivered",
    "refill_due",
    "adherence_missed",
    "request_help",
  ]),
  payload: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Dev-only convenience endpoint. Fires external-system style events for a user.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const eventType = parsed.data.event as EventType;
  const source =
    eventType === "request_help"
      ? "system"
      : eventType.startsWith("medication_") ||
          eventType === "refill_due" ||
          eventType === "adherence_missed"
        ? "pharmacy"
        : "openloop";

  const defaults: Record<string, Record<string, unknown>> = {
    consult_completed: {
      diagnosis: "Subclinical hormone imbalance",
      plan_summary: "8-week protocol: daily medication + weekly check-ins + sleep hygiene.",
    },
    prescription_issued: { medication_name: "LumaBalance", dosage: "1 capsule daily" },
    medication_shipped: { carrier: "UPS", tracking: "1Z999AA10123456784" },
    medication_delivered: {},
    refill_due: {},
    adherence_missed: { missed_doses: 2 },
    request_help: { simulated: true },
  };

  const payload = { ...(defaults[eventType] ?? {}), ...(parsed.data.payload ?? {}) };

  const event = await ingestEvent({
    userId: parsed.data.userId,
    type: eventType,
    source: source as "openloop" | "pharmacy" | "system",
    payload,
    idempotency_key: `simulate:${parsed.data.userId}:${eventType}:${Date.now()}`,
  });

  return NextResponse.json({ event });
}
