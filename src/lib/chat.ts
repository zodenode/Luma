import {
  appendAuditLog,
  appendChatSession,
  appendMemorySnapshot,
  getLatestMemorySnapshot,
  getMemory,
  getMessages,
  getTreatment,
  mutate,
  upsertMemory,
} from "./store";
import type { ChatMessage, EventType, StructuredCoachResponse } from "./types";
import { newId } from "./id";
import { generateChatReply, summarizeConversation, extractOpenThreads } from "./ai";
import { ingestEvent } from "./events";

interface AssistantMessageInput {
  userId: string;
  content: string;
  eventId?: string;
  kind?: NonNullable<ChatMessage["meta"]>["kind"];
  eventType?: EventType;
  structured?: StructuredCoachResponse;
}

export async function appendAssistantMessage(
  input: AssistantMessageInput,
): Promise<ChatMessage> {
  return mutate(async (db) => {
    const msg: ChatMessage = {
      id: newId("msg"),
      user_id: input.userId,
      role: "assistant",
      content: input.content,
      created_at: new Date().toISOString(),
      event_id: input.eventId,
      meta: {
        kind: input.kind ?? "chat",
        eventType: input.eventType,
        response_type: input.structured?.response_type,
        next_actions: input.structured?.next_actions,
        adherence_risk: input.structured?.adherence_risk,
        escalation_recommended: input.structured?.escalation_recommended,
        escalation_reason: input.structured?.escalation_reason ?? undefined,
      },
    };
    db.messages.push(msg);
    return msg;
  });
}

export async function appendUserMessage(
  userId: string,
  content: string,
  channel: "chat" | "action" = "chat",
): Promise<ChatMessage> {
  return mutate(async (db) => {
    const msg: ChatMessage = {
      id: newId("msg"),
      user_id: userId,
      role: "user",
      content,
      created_at: new Date().toISOString(),
      meta: { kind: "chat", channel },
    };
    db.messages.push(msg);
    return msg;
  });
}

const SUMMARY_EVERY_N = 8;

/**
 * Free-form chat: persist user message, emit lightweight check-in for timeline (no duplicate AI).
 */
export async function handleUserChat(
  userId: string,
  content: string,
  options?: { resumedSession?: boolean },
): Promise<ChatMessage> {
  await appendUserMessage(userId, content, "chat");

  await ingestEvent({
    userId,
    type: "user_checkin",
    source: "user",
    payload: { message_preview: content.slice(0, 140), channel: "chat" },
  });

  const history = await getMessages(userId);
  const reply = await generateChatReply({
    userId,
    history,
    resumedSession: Boolean(options?.resumedSession),
  });

  const assistant = await appendAssistantMessage({
    userId,
    content: reply.message,
    kind: "chat",
    structured: reply.structured,
  });

  if (reply.escalate) {
    await ingestEvent({
      userId,
      type: "escalation_triggered",
      source: "ai",
      payload: { reason: reply.escalationReason ?? "Risk detected in chat" },
    });
  }

  const refreshed = await getMessages(userId);
  if (refreshed.length > 0 && refreshed.length % SUMMARY_EVERY_N === 0) {
    await runSummarisation(userId, refreshed);
  }

  return assistant;
}

export async function runSummarisation(userId: string, messages: ChatMessage[]): Promise<void> {
  const summary = await summarizeConversation(messages);
  if (!summary) return;
  const openThreads = extractOpenThreads(summary, messages);
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  await upsertMemory(userId, summary, openThreads, lastAssistant?.id);
  const snap = await appendMemorySnapshot({
    user_id: userId,
    summary,
    open_threads: openThreads,
    source_message_from_id: messages[0]?.id,
    source_message_to_id: messages[messages.length - 1]?.id,
  });
  await appendAuditLog({
    action: "memory_summarized",
    user_id: userId,
    resource_type: "memory_snapshot",
    resource_id: snap.id,
    detail: { message_count: messages.length },
  });
}

export interface ChatSessionPacket {
  messages: ChatMessage[];
  treatment: Awaited<ReturnType<typeof getTreatment>>;
  memory: Awaited<ReturnType<typeof getMemory>>;
  latest_snapshot: Awaited<ReturnType<typeof getLatestMemorySnapshot>>;
  session_id: string;
}

export async function buildChatSessionRehydration(userId: string): Promise<ChatSessionPacket> {
  const [allMessages, treatment, memory, latest_snapshot] = await Promise.all([
    getMessages(userId),
    getTreatment(userId),
    getMemory(userId),
    getLatestMemorySnapshot(userId),
  ]);
  const messages = allMessages.slice(-20);
  const session = await appendChatSession({
    user_id: userId,
    rehydrated_snapshot_id: latest_snapshot?.id,
    started_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
  });
  return { messages, treatment, memory, latest_snapshot, session_id: session.id };
}
