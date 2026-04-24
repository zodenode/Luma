import { z } from "zod";
import { handleUserChat } from "@/lib/chat";
import { jsonError, jsonOk } from "@/lib/v1";
import { getOrCreateRequestId, logLine } from "@/lib/requestContext";

const Schema = z.object({
  userId: z.string().min(1),
  content: z.string().min(1).max(4000),
});

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const requestId = getOrCreateRequestId(req);
  const body = await req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return jsonError(req, 400, "invalid_body");

  const reply = await handleUserChat(parsed.data.userId, parsed.data.content);
  logLine("info", requestId, "chat_message", { userId: parsed.data.userId, message_id: reply.id });

  return jsonOk(req, { message: reply });
}
