import { NextResponse } from "next/server";
import { z } from "zod";
import { ingestEvent } from "@/lib/events";
import { getRequestId, withRequestIdHeaders } from "@/lib/requestContext";

const Schema = z
  .object({
    userId: z.string().min(1),
    note: z.string().max(500).optional(),
    symptom: z.string().max(200).optional(),
    severity: z.number().int().min(0).max(10).optional(),
    idempotency_key: z.string().max(200).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.symptom != null && val.severity === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "severity required with symptom" });
    }
  });

export async function POST(req: Request) {
  const requestId = getRequestId(req);
  const body = await req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return withRequestIdHeaders(
      NextResponse.json({ error: parsed.error.flatten() }, { status: 400 }),
      requestId,
    );
  }

  if (parsed.data.symptom != null && parsed.data.severity != null) {
    const idem =
      parsed.data.idempotency_key ??
      `symptom:${parsed.data.userId}:${parsed.data.symptom}:${parsed.data.severity}`;
    const event = await ingestEvent({
      userId: parsed.data.userId,
      type: "symptom_reported",
      source: "user",
      payload: {
        symptom: parsed.data.symptom,
        severity: parsed.data.severity,
        note: parsed.data.note ?? null,
      },
      idempotency_key: idem,
    });
    return withRequestIdHeaders(NextResponse.json({ event }), requestId);
  }

  const idem = parsed.data.idempotency_key ?? `checkin:${parsed.data.userId}:${requestId}`;
  const event = await ingestEvent({
    userId: parsed.data.userId,
    type: "user_checkin",
    source: "user",
    payload: { note: parsed.data.note ?? null, channel: "quick_action" },
    idempotency_key: idem,
  });
  return withRequestIdHeaders(NextResponse.json({ event }), requestId);
}
