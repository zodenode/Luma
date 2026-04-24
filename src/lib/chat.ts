import {
  getMessages,
  mutate,
  upsertMemory,
  appendMemorySnapshot,
  getLatestMemorySnapshot,
  createEscalation,
  appendKpiEvent,
} from "./store";
import type { ChatMessage, EventType, StructuredCoachResponse } from "./types";
import { newId } from "./id";
import { generateChatReply, summarizeConversation, extractOpenThreads } from "./ai";
import { ingestEvent } from "./events";

const SUMMARY_MESSAGE_INTERVAL = 8;

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
    const metadata: Record<string, unknown> = {
      kind: input.kind ?? "chat",
      eventType: input.eventType,
      structured: input.structured,
    };
    if (input.eventId) metadata.linked_event_ids = [input.eventId];
    const msg: ChatMessage = {
      id: newId("msg"),
      user_id: input.userId,
      role: "assistant",
      content: input.content,
      created_at: new Date().toISOString(),
      metadata,
      meta: {
        kind: input.kind ?? "chat",
        eventType: input.eventType,
      },
      event_id: input.eventId,
    };
    db.messages.push(msg);
    return msg;
  });
}

export async function appendUserMessage(
  userId: string,
  content: string,
  metadata?: Record<string, unknown>,
): Promise<ChatMessage> {
  return mutate(async (db) => {
    const msg: ChatMessage = {
      id: newId("msg"),
      user_id: userId,
      role: "user",
      content,
      created_at: new Date().toISOString(),
      metadata: { kind: "chat", ...metadata },
      meta: { kind: "chat" },
    };
    db.messages.push(msg);
    return msg;
  });
}

/**
 * Free-form chat: persist user message, run AI pipeline, persist assistant reply.
 * Check-ins are created via `POST /v1/actions/checkin`, not on every keystroke (plan §6).
 */
export async function handleUserChat(
  userId: string,
  content: string,
): Promise<ChatMessage> {
  await appendUserMessage(userId, content);
  await appendKpiEvent(userId, "weekly_engagement_signal", { channel: "chat" });

  const history = await getMessages(userId);
  const reply = await generateChatReply({ userId, history });

  const assistant = await appendAssistantMessage({
    userId,
    content: reply.message,
    kind: "chat",
    structured: reply.structured,
  });

  if (reply.escalate) {
    await createEscalation({
      userId,
      reason_code: "risk_signal",
      linkedEventId: undefined,
    });
    await ingestEvent({
      userId,
      type: "escalation_created",
      source: "ai",
      payload: { reason: reply.escalationReason ?? "Risk detected in chat" },
      idempotency_key: `escalation_chat:${assistant.id}`,
    });
  }

  const refreshed = await getMessages(userId);
  if (refreshed.length > 0 && refreshed.length % SUMMARY_MESSAGE_INTERVAL === 0) {
    await runSummarisation(userId, refreshed);
  }

  return assistant;
}

export async function runSummarisation(
  userId: string,
  messages?: ChatMessage[],
): Promise<{ summary: string; snapshot_id: string } | null> {
  const all = messages ?? (await getMessages(userId));
  if (all.length === 0) return null;
  const summary = await summarizeConversation(all);
  if (!summary) return null;
  const open_threads = extractOpenThreads(summary);
  const lastUser = [...all].reverse().find((m) => m.role === "user");
  const snap = await appendMemorySnapshot({
    user_id: userId,
    summary,
    open_threads,
    source_message_from_id: null,
    source_message_to_id: lastUser?.id ?? null,
    created_at: new Date().toISOString(),
  });
  await upsertMemory(userId, {
    summary,
    open_threads,
    last_summarized_message_id: lastUser?.id ?? null,
  });
  return { summary, snapshot_id: snap.id };
}

export async function buildChatSessionPacket(userId: string): Promise<{
  messages: ChatMessage[];
  treatment: import("./types").TreatmentState | undefined;
  memory: import("./types").ConversationMemory | undefined;
  latest_snapshot: import("./types").MemorySnapshot | undefined;
}> {
  const { getTreatment, getMemory } = await import("./store");
  const all = await getMessages(userId);
  const last20 = all.slice(-20);
  const [treatment, memory, latest_snapshot] = await Promise.all([
    getTreatment(userId),
    getMemory(userId),
    getLatestMemorySnapshot(userId),
  ]);
  return { messages: last20, treatment, memory, latest_snapshot };
}
