import { z } from "zod";
import { ingestEvent } from "@/lib/events";
import { jsonError, jsonOk } from "@/lib/v1";
import { getOrCreateRequestId, logLine } from "@/lib/requestContext";

const Schema = z.object({
  userId: z.string().min(1),
  reason: z.string().max(500).optional(),
});

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const requestId = getOrCreateRequestId(req);
  const body = await req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return jsonError(req, 400, "invalid_body");

  const event = await ingestEvent({
    userId: parsed.data.userId,
    type: "request_help",
    source: "user",
    payload: { reason: parsed.data.reason ?? "User requested help" },
    idempotency_key: `request_help:${parsed.data.userId}:${Date.now()}`,
  });

  logLine("info", requestId, "action_request_help", { userId: parsed.data.userId });
  return jsonOk(req, { event });
}
