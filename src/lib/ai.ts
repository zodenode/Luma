import OpenAI from "openai";
import { z } from "zod";
import { getLatestMemorySnapshot, getMemory, getTreatment, getUser } from "./store";
import type { CareEvent, ChatMessage, StructuredCoachResponse, TreatmentState, User } from "./types";

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const hasKey = Boolean(process.env.OPENAI_API_KEY);

const client = hasKey ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const StructuredResponseSchema = z.object({
  response_type: z.string(),
  message: z.string(),
  next_actions: z.array(z.string()).default([]),
  adherence_risk: z.enum(["low", "medium", "high"]),
  escalation_recommended: z.boolean(),
  escalation_reason: z.string().nullable(),
});

export interface CoachReply {
  message: string;
  kind: "greeting" | "event_followup" | "chat" | "nudge" | "escalation";
  escalate?: boolean;
  escalationReason?: string;
  structured?: StructuredCoachResponse;
}

const SYSTEM_PROMPT = `You are the user's ongoing health coach for longitudinal care support.
You are non-diagnostic and must not prescribe treatment changes.
You maintain continuity across sessions by using provided USER_STATE, MEMORY_SNAPSHOT, and RECENT_MESSAGES.
When the user returns, acknowledge prior context and continue open threads naturally.
If risk signals appear, recommend escalation using configured policy.
Tone: warm, concise, practical, supportive, and accountability-oriented.

You sit on top of telehealth + pharmacy (OpenLoop + pharmacy). Never invent clinical facts.
Keep the visible coach message short (2-5 sentences) unless the user asks for detail.`;

interface CoachContext {
  user: User;
  treatment?: TreatmentState;
  memorySummary?: string;
  openThreads?: string[];
  snapshotCreatedAt?: string;
}

async function loadContext(userId: string): Promise<CoachContext | null> {
  const user = await getUser(userId);
  if (!user) return null;
  const [treatment, memory, snap] = await Promise.all([
    getTreatment(userId),
    getMemory(userId),
    getLatestMemorySnapshot(userId),
  ]);
  return {
    user,
    treatment,
    memorySummary: memory?.summary || snap?.summary,
    openThreads: memory?.open_threads?.length ? memory.open_threads : snap?.open_threads,
    snapshotCreatedAt: snap?.created_at,
  };
}

function renderUserState(ctx: CoachContext): string {
  const { user, treatment } = ctx;
  const lines: string[] = [
    `- goal: ${user.goal.replace("_", " ")}`,
    `- treatment_stage: ${treatment?.stage ?? "intake"}`,
  ];
  const med = treatment?.medication;
  lines.push(
    `- active_medication: ${med ? JSON.stringify({ name: med.name, dosage: med.dosage, state: med.state }) : "null"}`,
  );
  lines.push(`- adherence_score: ${treatment?.adherence_score ?? "null"}`);
  lines.push(`- adherence_indicator: ${treatment?.adherence_indicator ?? "unknown"}`);
  lines.push(`- key_symptoms: ${JSON.stringify(treatment?.key_symptoms ?? user.symptoms ?? [])}`);
  lines.push(`- latest_lab_summary: ${treatment?.latest_lab_summary ?? "null"}`);
  lines.push(`- last_interaction_at: ${treatment?.last_interaction_at ?? "null"}`);
  if (user.symptoms.length) lines.push(`- intake_symptoms: ${user.symptoms.join(", ")}`);
  if (user.history) lines.push(`- relevant_history: ${user.history}`);
  if (treatment?.diagnosis) lines.push(`- diagnosis_from_clinician: ${treatment.diagnosis}`);
  if (treatment?.plan_summary) lines.push(`- plan_summary: ${treatment.plan_summary}`);
  if (treatment?.next_recommended_action) {
    lines.push(`- next_recommended_action: ${treatment.next_recommended_action}`);
  }
  return lines.join("\n");
}

function renderMemoryBlock(ctx: CoachContext): string {
  return [
    `- summary: ${ctx.memorySummary ?? ""}`,
    `- open_threads: ${JSON.stringify(ctx.openThreads ?? [])}`,
    `- snapshot_created_at: ${ctx.snapshotCreatedAt ?? "null"}`,
  ].join("\n");
}

function renderRecentMessages(history: ChatMessage[]): string {
  return history
    .slice(-20)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");
}

function buildContextPacket(args: {
  ctx: CoachContext;
  history: ChatMessage[];
  resumedSession: boolean;
  extra?: string;
}): string {
  const { ctx, history, resumedSession, extra } = args;
  return [
    resumedSession
      ? "SESSION: resumed (user reopened app). Start with a brief continuity signal."
      : "SESSION: active",
    "",
    "USER_STATE:",
    renderUserState(ctx),
    "",
    "MEMORY_SNAPSHOT:",
    renderMemoryBlock(ctx),
    "",
    "RECENT_MESSAGES (last 20):",
    renderRecentMessages(history),
    extra ? `\n${extra}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function detectRedFlags(text: string): string | null {
  const t = text.toLowerCase();
  const patterns: { pattern: RegExp; reason: string }[] = [
    { pattern: /\b(chest pain|can'?t breathe|shortness of breath)\b/, reason: "Possible cardiopulmonary symptoms" },
    { pattern: /\b(suicid|kill myself|end my life|self[- ]harm)\b/, reason: "Mental health crisis language" },
    { pattern: /\b(anaphylax|swelling of (my )?throat|severe rash|can'?t swallow)\b/, reason: "Possible severe allergic reaction" },
    { pattern: /\b(severe bleeding|passing out|lost consciousness|blood in)\b/, reason: "Severe physical symptoms" },
    { pattern: /\b(pregnan(t|cy))\b/, reason: "Pregnancy — treatment review needed" },
  ];
  for (const { pattern, reason } of patterns) {
    if (pattern.test(t)) return reason;
  }
  return null;
}

function parseStructuredJson(text: string): StructuredCoachResponse | null {
  const trimmed = text.trim();
  const jsonBlock = trimmed.match(/\{[\s\S]*\}/);
  const raw = jsonBlock ? jsonBlock[0] : trimmed;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return StructuredResponseSchema.parse(parsed) as StructuredCoachResponse;
  } catch {
    return null;
  }
}

function defaultStructured(message: string, responseType: string): StructuredCoachResponse {
  return {
    response_type: responseType,
    message,
    next_actions: [],
    adherence_risk: "low",
    escalation_recommended: false,
    escalation_reason: null,
  };
}

// --- Event follow-ups --------------------------------------------------------

export async function generateEventFollowup(event: CareEvent): Promise<CoachReply | null> {
  const ctx = await loadContext(event.user_id);
  if (!ctx) return null;

  const kind = event.type === "escalation_triggered" ? "escalation" : "event_followup";

  if (!client) {
    const message = mockEventFollowup(event, ctx);
    return { message, kind, structured: defaultStructured(message, "event_followup") };
  }

  const userPrompt = `A new clinical/system event arrived. Respond with a single JSON object ONLY (no markdown) matching this schema:
{"response_type":"string","message":"string","next_actions":["string"],"adherence_risk":"low|medium|high","escalation_recommended":boolean,"escalation_reason":string|null}

Rules for message: 2-4 sentences, warm, plain language, one concrete next action implied in next_actions.

Event:
${JSON.stringify({ type: event.type, payload: event.payload }, null, 2)}

Context:
${buildContextPacket({ ctx, history: [], resumedSession: false })}`;

  try {
    const res = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.5,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    });
    const raw = res.choices[0]?.message?.content?.trim();
    const structured = raw ? parseStructuredJson(raw) : null;
    if (structured) {
      return {
        message: structured.message,
        kind,
        structured,
        escalate: structured.escalation_recommended,
        escalationReason: structured.escalation_reason ?? undefined,
      };
    }
    const message = mockEventFollowup(event, ctx);
    return { message, kind, structured: defaultStructured(message, "event_followup") };
  } catch (err) {
    console.warn("[ai] event followup fallback:", err);
    const message = mockEventFollowup(event, ctx);
    return { message, kind, structured: defaultStructured(message, "event_followup") };
  }
}

// --- User chat --------------------------------------------------------------

export async function generateChatReply(args: {
  userId: string;
  history: ChatMessage[];
  resumedSession: boolean;
}): Promise<CoachReply> {
  const ctx = await loadContext(args.userId);
  if (!ctx) {
    const message = "I can't find your profile. Please complete intake first.";
    return { message, kind: "chat", structured: defaultStructured(message, "error") };
  }

  const latestUser = [...args.history].reverse().find((m) => m.role === "user");
  const escalationReason = latestUser ? detectRedFlags(latestUser.content) : null;

  if (!client) {
    const reply = mockChatReply(args.history, ctx, args.resumedSession);
    const structured = defaultStructured(reply, "chat");
    return {
      message: reply,
      kind: "chat",
      structured,
      escalate: Boolean(escalationReason),
      escalationReason: escalationReason ?? undefined,
    };
  }

  const trimmed = args.history.slice(-16);
  const userPrompt = `The user sent a chat message. Output a single JSON object ONLY (no markdown) with schema:
{"response_type":"string","message":"string","next_actions":["string"],"adherence_risk":"low|medium|high","escalation_recommended":boolean,"escalation_reason":string|null}

Advance one open thread (if any) plus one concrete next action in next_actions.
${args.resumedSession ? "Begin message with a short continuity signal (e.g. Good to see you back)." : ""}

Context:
${buildContextPacket({ ctx, history: args.history, resumedSession: args.resumedSession })}`;

  try {
    const res = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.6,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
        ...trimmed.map((m) => ({
          role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user",
          content: m.content,
        })) as { role: "user" | "assistant" | "system"; content: string }[],
      ],
    });
    const raw = res.choices[0]?.message?.content?.trim();
    const structured = raw ? parseStructuredJson(raw) : null;
    if (structured) {
      return {
        message: structured.message,
        kind: "chat",
        structured,
        escalate: Boolean(escalationReason) || structured.escalation_recommended,
        escalationReason: escalationReason ?? structured.escalation_reason ?? undefined,
      };
    }
    const reply = mockChatReply(args.history, ctx, args.resumedSession);
    return {
      message: reply,
      kind: "chat",
      structured: defaultStructured(reply, "chat"),
      escalate: Boolean(escalationReason),
      escalationReason: escalationReason ?? undefined,
    };
  } catch (err) {
    console.warn("[ai] chat reply fallback:", err);
    const reply = mockChatReply(args.history, ctx, args.resumedSession);
    return {
      message: reply,
      kind: "chat",
      structured: defaultStructured(reply, "chat"),
      escalate: Boolean(escalationReason),
      escalationReason: escalationReason ?? undefined,
    };
  }
}

// --- Conversation memory ----------------------------------------------------

export async function summarizeConversation(messages: ChatMessage[]): Promise<string | null> {
  if (messages.length === 0) return null;
  if (!client) return mockSummary(messages);

  const transcript = messages
    .slice(-30)
    .map((m) => `${m.role === "user" ? "User" : "Coach"}: ${m.content}`)
    .join("\n");

  try {
    const res = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "Summarize this health coaching conversation into 4-6 short bullet points covering: symptoms mentioned, side effects, adherence signals, user preferences, and anything the coach should remember next time. Keep under 120 words.",
        },
        { role: "user", content: transcript },
      ],
    });
    return res.choices[0]?.message?.content?.trim() ?? mockSummary(messages);
  } catch {
    return mockSummary(messages);
  }
}

export function extractOpenThreads(summary: string, messages: ChatMessage[]): string[] {
  const fromSummary = summary
    .split("\n")
    .map((l) => l.replace(/^[-•*]\s*/, "").trim())
    .filter((l) => l.length > 4)
    .slice(0, 5);
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (lastUser && lastUser.content.length < 200) {
    return Array.from(new Set([`Follow up on: ${lastUser.content.slice(0, 120)}`, ...fromSummary])).slice(0, 6);
  }
  return fromSummary;
}

// --- Mock fallbacks ---------------------------------------------------------

function mockEventFollowup(event: CareEvent, ctx: CoachContext): string {
  const name = ctx.user.name.split(" ")[0];
  switch (event.type) {
    case "intake_completed":
      return `Thanks for finishing intake, ${name}. I've set your goal to ${ctx.user.goal.replace("_", " ")}. Next up: your telehealth consult — I'll be here right after to explain anything the clinician says.`;
    case "consult_completed":
      return `Your consult is done, ${name}. I'll walk you through the plan whenever you're ready — just ask "what's my plan?" and I'll break it down.`;
    case "prescription_issued": {
      const med = (event.payload.medication_name as string) ?? "your medication";
      return `Good news — ${med} was prescribed. Pharmacy is preparing it now. I'll ping you the moment it ships and help you start strong.`;
    }
    case "medication_shipped":
      return `Your medication shipped. While it's on the way, take 30 seconds to tell me when you'd like daily reminders — morning, evening, or tied to a meal?`;
    case "medication_delivered":
      return `Your medication arrived. Log your first dose when you take it — it helps me tune your reminders and catch side effects early.`;
    case "adherence_missed":
      return `Looks like a dose got missed — totally normal. Want to tell me what got in the way, or should I just nudge you at a different time tomorrow?`;
    case "refill_due":
      return `Heads up: your refill is due. Confirm it in one tap and you won't lose momentum on your ${ctx.user.goal.replace("_", " ")} goal.`;
    case "symptom_reported":
      return `Thanks for flagging that. I've logged it on your timeline. If it gets worse or you're worried, I can loop in a clinician — just say the word.`;
    case "request_help":
      return `I've routed your request to the care team. They'll follow up soon — I'm still here if you want to talk through anything in the meantime.`;
    case "escalation_triggered":
      return `I've flagged this for a human clinician to review. They'll reach out soon. In the meantime I'm still here — no pressure to explain more unless you want to.`;
    default:
      return `Got it, ${name}. I've updated your plan.`;
  }
}

function mockChatReply(history: ChatMessage[], ctx: CoachContext, resumed: boolean): string {
  const last = [...history].reverse().find((m) => m.role === "user");
  const name = ctx.user.name.split(" ")[0];
  if (resumed) {
    return `Good to see you back, ${name}. ${ctx.treatment?.next_recommended_action ? `Next up: ${ctx.treatment.next_recommended_action}` : "How are you feeling today?"}`;
  }
  if (!last) return `Hey ${name} — how are you feeling today?`;
  const text = last.content.toLowerCase();
  if (/plan|treatment/.test(text)) {
    return ctx.treatment?.plan_summary
      ? `Here's the short version of your plan: ${ctx.treatment.plan_summary}. Want me to break down any piece of it?`
      : `Your plan isn't finalized yet. Once your consult wraps, I'll walk you through every step.`;
  }
  if (/side effect|nausea|headache|tired/.test(text)) {
    return `That can happen in the first couple of weeks. Track it for me for 3 days — time of day, severity 1–10. If it gets worse or new symptoms show up, I'll loop in a clinician.`;
  }
  if (/miss|forgot/.test(text)) {
    return `No stress — missed doses happen. Want to shift your reminder time, or tie it to something you already do daily (coffee, brushing teeth)?`;
  }
  return `Heard you. Tell me a bit more — is this new today, or has it been building up?`;
}

function mockSummary(messages: ChatMessage[]): string {
  const last = messages.slice(-10).map((m) => `• ${m.role}: ${m.content.slice(0, 60)}`);
  return `Recent exchange:\n${last.join("\n")}`;
}
