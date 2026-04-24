import { handleUserChat } from "@/lib/chat";
import { jsonWithRequestId, getOrCreateRequestId } from "@/lib/request-id";
import { z } from "zod";

const Body = z.object({
  userId: z.string().min(1),
  content: z.string().min(1).max(4000),
  resumedSession: z.boolean().optional(),
});

export async function POST(req: Request) {
  const requestId = getOrCreateRequestId(req);
  const body = await req.json().catch(() => null);
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return jsonWithRequestId({ error: parsed.error.flatten() }, { requestId, status: 400 });
  }
  const reply = await handleUserChat(parsed.data.userId, parsed.data.content, {
    resumedSession: parsed.data.resumedSession,
  });
  return jsonWithRequestId({ reply }, { requestId });
}
