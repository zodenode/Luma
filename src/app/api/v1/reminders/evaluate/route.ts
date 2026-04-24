import { NextResponse } from "next/server";
import { z } from "zod";
import { ingestEvent } from "@/lib/events";
import { listUsers, readDB } from "@/lib/store";
import { getRequestId, withRequestIdHeaders } from "@/lib/requestContext";

const STALE_MS = 36 * 60 * 60 * 1000;

function verifyInternal(req: Request): boolean {
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) return true;
  return req.headers.get("x-internal-token") === token;
}

/**
 * Idempotent daily-style nudge: if user is on active medication but has not
 * logged adherence recently, emit a single adherence_missed per UTC day.
 * In production, invoke from a scheduler (cron, queue worker).
 */
export async function POST(req: Request) {
  const requestId = getRequestId(req);
  if (!verifyInternal(req)) {
    return withRequestIdHeaders(NextResponse.json({ error: "forbidden" }, { status: 403 }), requestId);
  }

  const body = await req.json().catch(() => ({}));
  const parsed = z.object({ userId: z.string().optional() }).safeParse(body);
  if (!parsed.success) {
    return withRequestIdHeaders(
      NextResponse.json({ error: parsed.error.flatten() }, { status: 400 }),
      requestId,
    );
  }

  const db = await readDB();
  const users = parsed.data.userId
    ? db.users.filter((u) => u.id === parsed.data.userId)
    : await listUsers();

  const dayKey = new Date().toISOString().slice(0, 10);
  let emitted = 0;

  for (const user of users) {
    const t = db.treatments.find((x) => x.user_id === user.id);
    if (!t?.medication || t.medication.state !== "active") continue;
    const lastCheck = t.medication.last_adherence_check;
    const lastTs = lastCheck ? new Date(lastCheck).getTime() : 0;
    if (lastTs && Date.now() - lastTs < STALE_MS) continue;

    const idem = `reminder:adherence:${user.id}:${dayKey}`;
    await ingestEvent({
      userId: user.id,
      type: "adherence_missed",
      source: "system",
      payload: { reason: "scheduled_evaluation", evaluated_at: new Date().toISOString() },
      idempotency_key: idem,
    });
    emitted += 1;
  }

  return withRequestIdHeaders(NextResponse.json({ evaluated: users.length, emitted }), requestId);
}
