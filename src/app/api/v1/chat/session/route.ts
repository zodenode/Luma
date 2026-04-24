import { buildChatSessionPacket } from "@/lib/chat";
import { recordChatSession } from "@/lib/store";
import { getUser } from "@/lib/store";
import { jsonError, jsonOk, requireUserId } from "@/lib/v1";
import { getOrCreateRequestId, logLine } from "@/lib/requestContext";

export const dynamic = "force-dynamic";

/**
 * GET /v1/chat/session?userId= — rehydrate last 20 messages, treatment state, memory (plan §7.1).
 */
export async function GET(req: Request) {
  const requestId = getOrCreateRequestId(req);
  const userId = requireUserId(req);
  if (!userId) return jsonError(req, 400, "missing_user_id", "Provide userId query parameter.");

  const user = await getUser(userId);
  if (!user) return jsonError(req, 404, "user_not_found");

  const packet = await buildChatSessionPacket(userId);
  const session = await recordChatSession({
    userId,
    rehydrated_snapshot_id: packet.latest_snapshot?.id ?? null,
  });

  logLine("info", requestId, "chat_session_rehydrated", { userId, session_id: session.id });

  return jsonOk(req, {
    session_id: session.id,
    user: { id: user.id, goal: user.goal, name: user.name },
    messages: packet.messages,
    treatment: packet.treatment,
    conversation_memory: packet.memory,
    latest_memory_snapshot: packet.latest_snapshot,
  });
}
