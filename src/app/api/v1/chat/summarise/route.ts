import { NextResponse } from "next/server";
import { z } from "zod";
import { runSummarisation } from "@/lib/chat";
import { getMessages } from "@/lib/store";
import { getRequestId, withRequestIdHeaders } from "@/lib/requestContext";

const Schema = z.object({
  userId: z.string().min(1),
});

function verifyInternal(req: Request): boolean {
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) return true;
  return req.headers.get("x-internal-token") === token;
}

export async function POST(req: Request) {
  const requestId = getRequestId(req);
  if (!verifyInternal(req)) {
    return withRequestIdHeaders(NextResponse.json({ error: "forbidden" }, { status: 403 }), requestId);
  }
  const body = await req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return withRequestIdHeaders(
      NextResponse.json({ error: parsed.error.flatten() }, { status: 400 }),
      requestId,
    );
  }
  const messages = await getMessages(parsed.data.userId);
  await runSummarisation(parsed.data.userId, messages);
  return withRequestIdHeaders(NextResponse.json({ ok: true }), requestId);
}
