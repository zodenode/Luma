import { generateChatReply } from "@/lib/ai";
import { appendAssistantMessage, appendChatSession, getEvents, getLatestMemorySnapshot, getMemory, getMessages, getTreatment, getUser } from "@/lib/store";
import { jsonWithRequestId, getOrCreateRequestId } from "@/lib/request-id";
import { z } from "zod";

export const dynamic = "force-dynamic";

const Query = z.object({
  userId: z.string().min(1),
});

/** GET /api/v1/chat/session — plan §6.1 + §7.1 */
export async function GET(req: Request) {
  const requestId = getOrCreateRequestId(req);
  const url = new URL(req.url);
  const parsed = Query.safeParse({ userId: url.searchParams.get("userId") });
  if (!parsed.success) {
    return jsonWithRequestId({ error: parsed.error.flatten() }, { requestId, status: 400 });
  }
  const userId = parsed.data.userId;

  const user = await getUser(userId);
  if (!user) return jsonWithRequestId({ error: "not_found" }, { requestId, status: 404 });

  const [treatment, latestMemory, latestSnapshot, allMessages, events] = await Promise.all([
    getTreatment(userId),
    getMemory(userId),
    getLatestMemorySnapshot(userId),
    getMessages(userId),
    getEvents(userId),
  ]);

  const messagesDesc = [...allMessages].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const last20 = [...allMessages].slice(-20);

  await appendChatSession({
    user_id: userId,
    rehydrated_snapshot_id: latestSnapshot?.id,
    started_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
  });

  let messagesOut = last20;
  const last = messagesDesc[0];
  const hasContext =
    Boolean(latestMemory?.summary?.trim()) ||
    Boolean(latestSnapshot?.summary?.trim()) ||
    (latestMemory?.open_threads?.length ?? 0) > 0;

  if (hasContext && last?.role === "user") {
    const history = await getMessages(userId);
    const reply = await generateChatReply({ userId, history, resumedSession: true });
    await appendAssistantMessage({
      userId,
      content: reply.message,
      kind: "chat",
      structured: reply.structured,
    });
    messagesOut = (await getMessages(userId)).slice(-20);
  }

  return jsonWithRequestId(
    {
      messages: messagesOut,
      treatment_state: treatment,
      memory_snapshot: latestSnapshot ?? {
        summary: latestMemory?.summary ?? "",
        open_threads: latestMemory?.open_threads ?? [],
        created_at: latestMemory?.updated_at ?? null,
      },
      recent_event_count: events.filter((e) => e.type !== "user_checkin").length,
    },
    { requestId },
  );
}
