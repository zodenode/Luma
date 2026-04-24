import { NextResponse } from "next/server";
import { z } from "zod";
import { ingestEvent } from "@/lib/events";

const Schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("log_medication"),
    userId: z.string(),
    taken: z.boolean(),
    note: z.string().optional(),
  }),
  z.object({
    action: z.literal("checkin_symptom"),
    userId: z.string(),
    symptom: z.string().min(1).max(200),
    severity: z.number().int().min(0).max(10),
    note: z.string().optional(),
  }),
  z.object({
    action: z.literal("request_help"),
    userId: z.string(),
    reason: z.string().max(500).optional(),
  }),
]);

/** @deprecated Prefer POST /api/v1/actions/* */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  switch (parsed.data.action) {
    case "log_medication": {
      const event = await ingestEvent({
        userId: parsed.data.userId,
        type: parsed.data.taken ? "user_checkin" : "adherence_missed",
        source: "user",
        payload: {
          adherence_log: true,
          taken: parsed.data.taken,
          note: parsed.data.note ?? null,
        },
        idempotency_key: `legacy_log_med:${parsed.data.userId}:${Date.now()}`,
      });
      return NextResponse.json({ event });
    }
    case "checkin_symptom": {
      const event = await ingestEvent({
        userId: parsed.data.userId,
        type: "symptom_reported",
        source: "user",
        payload: {
          symptom: parsed.data.symptom,
          severity: parsed.data.severity,
          note: parsed.data.note ?? null,
        },
        idempotency_key: `legacy_symptom:${parsed.data.userId}:${Date.now()}`,
      });
      return NextResponse.json({ event });
    }
    case "request_help": {
      const event = await ingestEvent({
        userId: parsed.data.userId,
        type: "request_help",
        source: "user",
        payload: { reason: parsed.data.reason ?? "User requested help" },
        idempotency_key: `legacy_help:${parsed.data.userId}:${Date.now()}`,
      });
      return NextResponse.json({ event });
    }
  }
}
