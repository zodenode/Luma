import { NextResponse } from "next/server";
import { z } from "zod";
import { handleUserChat } from "@/lib/chat";
import { getRequestId, withRequestIdHeaders } from "@/lib/requestContext";

const Schema = z.object({
  userId: z.string().min(1),
  content: z.string().min(1).max(4000),
});

/** @deprecated Use POST /api/v1/chat/message */
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
  const reply = await handleUserChat(parsed.data.userId, parsed.data.content);
  return withRequestIdHeaders(NextResponse.json({ reply }), requestId);
}
