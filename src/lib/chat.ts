import type { ChatMessage } from "./types";
import {
  appendAssistantMessage,
  appendUserMessage,
  getMessages,
  upsertMemory,
} from "./store";
import { generateChatReply, maybeSummarizeAndSnapshot, summarizeConversation } from "./ai";
import { ingestEvent } from "./events";
import { recordAssistantEngagement } from "./kpi";

/**
 * Handle a free-form message from the user.
 * Persists message, logs user_checkin (timeline) without duplicate AI follow-up,
 * then generates one coaching reply.
 */
export async function handleUserChat(
  userId: string,
  content: string,
  options?: { resumedSession?: boolean },
): Promise<ChatMessage> {
  const userMsg = await appendUserMessage(userId, content);

  await ingestEvent({
    userId,
    type: "user_checkin",
    source: "user",
    payload: { message_preview: content.slice(0, 140) },
    idempotencyKey: `user_checkin:${userMsg.id}`,
    skipFollowup: true,
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

  await recordAssistantEngagement(userId);

  if (reply.escalate) {
    await ingestEvent({
      userId,
      type: "escalation_triggered",
      source: "ai",
      payload: { reason: reply.escalationReason ?? "Risk detected in chat" },
      idempotencyKey: `escalation:chat:${assistant.id}`,
    });
  }

  const refreshed = await getMessages(userId);
  await maybeSummarizeAndSnapshot(userId, refreshed);

  return assistant;
}

export async function runSummariseJob(userId: string): Promise<{ summary: string } | { error: string }> {
  const messages = await getMessages(userId);
  const summary = await summarizeConversation(messages, true);
  if (!summary) return { error: "nothing_to_summarize" };
  await upsertMemory(userId, summary.text, summary.open_threads, summary.last_message_id);
  return { summary: summary.text };
}
