import { z } from "zod";
import { ingestEvent } from "@/lib/events";
import { jsonError, jsonOk } from "@/lib/v1";
import { getOrCreateRequestId, logLine } from "@/lib/requestContext";

const Schema = z.object({
  userId: z.string().min(1),
  note: z.string().max(500).optional(),
  /** Optional symptom check-in (creates `symptom_reported` instead of plain check-in). */
  symptom: z.string().max(200).optional(),
  severity: z.number().int().min(0).max(10).optional(),
});

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const requestId = getOrCreateRequestId(req);
  const body = await req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return jsonError(req, 400, "invalid_body");

  if (parsed.data.symptom && parsed.data.symptom.trim().length > 0) {
    const sev = parsed.data.severity ?? 3;
    const event = await ingestEvent({
      userId: parsed.data.userId,
      type: "symptom_reported",
      source: "user",
      payload: {
        symptom: parsed.data.symptom.trim(),
        severity: sev,
        note: parsed.data.note ?? null,
      },
      idempotency_key: `checkin_symptom:${parsed.data.userId}:${Date.now()}`,
    });
    logLine("info", requestId, "action_checkin_symptom", { userId: parsed.data.userId });
    return jsonOk(req, { event });
  }

  const event = await ingestEvent({
    userId: parsed.data.userId,
    type: "user_checkin",
    source: "user",
    payload: { note: parsed.data.note ?? null },
    idempotency_key: `checkin:${parsed.data.userId}:${Date.now()}`,
  });

  logLine("info", requestId, "action_checkin", { userId: parsed.data.userId, event_id: event.id });
  return jsonOk(req, { event });
}
