import { NextResponse } from "next/server";
import { z } from "zod";
import { appendAssistantMessage, buildChatSessionRehydration } from "@/lib/chat";
import { generateChatReply } from "@/lib/ai";
import { treatmentToCareState } from "@/lib/careApi";
import { getMessages, getUser } from "@/lib/store";
import { getRequestId, withRequestIdHeaders } from "@/lib/requestContext";

const STALE_MS = 10 * 60 * 1000;

export async function POST(req: Request) {
  const requestId = getRequestId(req);
  const body = await req.json().catch(() => null);
  const parsed = z.object({ userId: z.string().min(1) }).safeParse(body);
  if (!parsed.success) {
    return withRequestIdHeaders(
      NextResponse.json({ error: parsed.error.flatten() }, { status: 400 }),
      requestId,
    );
  }
  const user = await getUser(parsed.data.userId);
  if (!user) {
    return withRequestIdHeaders(NextResponse.json({ error: "not_found" }, { status: 404 }), requestId);
  }

  const packet = await buildChatSessionRehydration(parsed.data.userId);
  const fullHistory = await getMessages(parsed.data.userId);
  const last = fullHistory[fullHistory.length - 1];
  const hasMemory = Boolean(
    packet.memory?.summary?.trim() ||
      (packet.memory?.open_threads?.length ?? 0) > 0 ||
      (packet.latest_snapshot?.summary?.trim() ?? "").length > 0,
  );
  const lastTs = last ? new Date(last.created_at).getTime() : 0;
  const stale = !last || Date.now() - lastTs > STALE_MS;
  const shouldBootstrap =
    fullHistory.length > 0 &&
    hasMemory &&
    stale &&
    last?.role !== "assistant";

  if (shouldBootstrap) {
    const reply = await generateChatReply({
      userId: parsed.data.userId,
      history: fullHistory,
      resumedSession: true,
    });
    await appendAssistantMessage({
      userId: parsed.data.userId,
      content: reply.message,
      kind: "greeting",
      structured: reply.structured,
    });
  }

  const refreshed = await buildChatSessionRehydration(parsed.data.userId);
  return withRequestIdHeaders(
    NextResponse.json({
      session_id: refreshed.session_id,
      bootstrapped: shouldBootstrap,
      messages: refreshed.messages,
      care_state: treatmentToCareState(refreshed.treatment),
      conversation_memory: refreshed.memory ?? { summary: "", open_threads: [] },
      latest_memory_snapshot: refreshed.latest_snapshot ?? null,
    }),
    requestId,
  );
}
