import { getMessages, mutate, upsertMemory } from "./store";
import type { ChatMessage, EventType } from "./types";
import { newId } from "./id";
import { generateChatReply, summarizeConversation } from "./ai";
import { ingestEvent } from "./events";

interface AssistantMessageInput {
  userId: string;
  content: string;
  eventId?: string;
  kind?: NonNullable<ChatMessage["meta"]>["kind"];
  eventType?: EventType;
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
      },
    };
    db.messages.push(msg);
    return msg;
  });
}

export async function appendUserMessage(
  userId: string,
  content: string,
): Promise<ChatMessage> {
  return mutate(async (db) => {
    const msg: ChatMessage = {
      id: newId("msg"),
      user_id: userId,
      role: "user",
      content,
      created_at: new Date().toISOString(),
      meta: { kind: "chat" },
    };
    db.messages.push(msg);
    return msg;
  });
}

/**
 * Handle a free-form message from the user.
 *
 * We log a user_checkin event (so the timeline reflects engagement and
 * adherence signal), then generate a coaching reply grounded in the user's
 * current treatment state + conversation memory.
 */
export async function handleUserChat(
  userId: string,
  content: string,
): Promise<ChatMessage> {
  await appendUserMessage(userId, content);

  await ingestEvent({
    userId,
    type: "user_checkin",
    source: "user",
    payload: { message_preview: content.slice(0, 140) },
  });

  const history = await getMessages(userId);
  const reply = await generateChatReply({ userId, history });

  const assistant = await appendAssistantMessage({
    userId,
    content: reply.message,
    kind: "chat",
  });

  if (reply.escalate) {
    await ingestEvent({
      userId,
      type: "escalation_triggered",
      source: "ai",
      payload: { reason: reply.escalationReason ?? "Risk detected in chat" },
    });
  }

  // Cheap, rolling memory update. Every ~6 turns we refresh the summary.
  const refreshed = await getMessages(userId);
  if (refreshed.length % 6 === 0) {
    const summary = await summarizeConversation(refreshed);
    if (summary) await upsertMemory(userId, summary);
  }

  return assistant;
}
