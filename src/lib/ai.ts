import OpenAI from "openai";
import { z } from "zod";
import {
  appendMemorySnapshot,
  getLatestMemorySnapshot,
  getMemory,
  getMessages,
  getTreatment,
  getUser,
  upsertMemory,
} from "./store";
import type { CareEvent, ChatMessage, TreatmentState, User } from "./types";

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const hasKey = Boolean(process.env.OPENAI_API_KEY);
const SUMMARY_EVERY_N = Number(process.env.CHAT_SUMMARY_EVERY_N || "8");

const client = hasKey ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const StructuredResponseSchema = z.object({
  response_type: z.string(),
  message: z.string(),
  next_actions: z.array(z.string()).default([]),
  adherence_risk: z.enum(["low", "medium", "high"]).default("low"),
  escalation_recommended: z.boolean().default(false),
  escalation_reason: z.string().nullable().optional(),
});

export type StructuredCoachResponse = z.infer<typeof StructuredResponseSchema>;

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

When asked for structured output, reply with a single JSON object only (no markdown) matching this shape:
{"response_type":"string","message":"string","next_actions":["string"],"adherence_risk":"low|medium|high","escalation_recommended":boolean,"escalation_reason":string|null}`;

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
  const [treatment, memory, latestSnap] = await Promise.all([
    getTreatment(userId),
    getMemory(userId),
    getLatestMemorySnapshot(userId),
  ]);
  return {
    user,
    treatment,
    memorySummary: memory?.summary,
    openThreads: memory?.open_threads?.length
      ? memory.open_threads
      : latestSnap?.open_threads,
    snapshotCreatedAt: latestSnap?.created_at,
  };
}

function formatActiveMedication(t?: TreatmentState): string {
  if (!t?.medication) return "none";
  const m = t.medication;
  return JSON.stringify({
    name: m.name,
    dosage: m.dosage,
    state: m.state,
  });
}

function renderUserStateBlock(ctx: CoachContext): string {
  const { user, treatment } = ctx;
  const goal = user.goal.replace("_", " ");
  const stage = treatment?.stage ?? "intake";
  const activeMedication = formatActiveMedication(treatment);
  const adherence_score =
    treatment?.adherence_score != null ? String(treatment.adherence_score) : "unknown";
  const key_symptoms = JSON.stringify(
    treatment?.key_symptoms?.length ? treatment.key_symptoms : user.symptoms,
  );
  const latest_lab_summary = treatment?.latest_lab_summary ?? "";
  const last_interaction_at = treatment?.last_interaction_at ?? "";

  return `USER_STATE:
- goal: ${goal}
- treatment_stage: ${stage}
- active_medication: ${activeMedication}
- adherence_score: ${adherence_score}
- key_symptoms: ${key_symptoms}
- latest_lab_summary: ${latest_lab_summary}
- last_interaction_at: ${last_interaction_at}`;
}

function renderMemoryBlock(ctx: CoachContext): string {
  const summary = ctx.memorySummary ?? "";
  const open_threads = JSON.stringify(ctx.openThreads ?? []);
  const snapshot_created_at = ctx.snapshotCreatedAt ?? "";
  return `MEMORY_SNAPSHOT:
- summary: ${summary}
- open_threads: ${open_threads}
- snapshot_created_at: ${snapshot_created_at}`;
}

function renderRecentMessages(history: ChatMessage[]): string {
  const last = history.slice(-20);
  return last
    .map(
      (m) =>
        `${m.role}: ${m.content.slice(0, 2000)}${m.content.length > 2000 ? "…" : ""}`,
    )
    .join("\n");
}

function buildContextPacket(args: {
  ctx: CoachContext;
  history: ChatMessage[];
  resumedSession: boolean;
}): string {
  const { ctx, history, resumedSession } = args;
  const extra = resumedSession
    ? "\nThe user is returning to the app. Start with a brief continuity signal (e.g. welcoming them back) and advance one open thread plus one concrete next action."
    : "";
  return `${renderUserStateBlock(ctx)}

${renderMemoryBlock(ctx)}

RECENT_MESSAGES (last 20):
${renderRecentMessages(history)}
${extra}`;
}

function parseStructured(raw: string): StructuredCoachResponse | null {
  const trimmed = raw.trim();
  try {
    const jsonStart = trimmed.indexOf("{");
    const jsonEnd = trimmed.lastIndexOf("}");
    const slice =
      jsonStart >= 0 && jsonEnd > jsonStart ? trimmed.slice(jsonStart, jsonEnd + 1) : trimmed;
    const parsed = JSON.parse(slice) as unknown;
    const res = StructuredResponseSchema.safeParse(parsed);
    return res.success ? res.data : null;
  } catch {
    return null;
  }
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

// --- Event follow-ups --------------------------------------------------------

export async function generateEventFollowup(event: CareEvent): Promise<CoachReply | null> {
  const ctx = await loadContext(event.user_id);
  if (!ctx) return null;

  const kind =
    event.type === "escalation_triggered" || event.type === "request_help"
      ? "escalation"
      : "event_followup";

  if (!client) {
    const message = mockEventFollowup(event, ctx);
    const highSymptom =
      event.type === "symptom_reported" && Number(event.payload.severity ?? 0) >= 8;
    return {
      message,
      kind,
      structured: {
        response_type: "event_followup",
        message,
        next_actions: [],
        adherence_risk: highSymptom ? "high" : "low",
        escalation_recommended: false,
        escalation_reason: null,
      },
      // Severity-based queue row is created in ingestEvent; avoid duplicate escalation_triggered.
      escalate: false,
    };
  }

  const userPrompt = `A clinical/system event arrived. Respond with JSON only.

Event:
${JSON.stringify(
  { type: event.type, payload: event.payload, occurred_at: event.occurred_at },
  null,
  2,
)}

${buildContextPacket({ ctx, history: await getMessages(event.user_id), resumedSession: false })}

Requirements:
- message: 2-4 sentences, plain language, one next action.
- If user needs human review, set escalation_recommended true and escalation_reason.`;

  try {
    const res = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.45,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    });
    const raw = res.choices[0]?.message?.content?.trim() ?? "";
    const structured = parseStructured(raw);
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
    return { message, kind };
  } catch (err) {
    console.warn("[ai] event followup fallback:", err);
    return { message: mockEventFollowup(event, ctx), kind };
  }
}

// --- User chat --------------------------------------------------------------

export async function generateChatReply(args: {
  userId: string;
  history: ChatMessage[];
  resumedSession?: boolean;
}): Promise<CoachReply> {
  const ctx = await loadContext(args.userId);
  if (!ctx) {
    return { message: "I can't find your profile. Please complete intake first.", kind: "chat" };
  }

  const latestUser = [...args.history].reverse().find((m) => m.role === "user");
  const escalationReason = latestUser ? detectRedFlags(latestUser.content) : null;

  if (!client) {
    const message = mockChatReply(args.history, ctx);
    return {
      message,
      kind: "chat",
      escalate: Boolean(escalationReason),
      escalationReason: escalationReason ?? undefined,
      structured: {
        response_type: "daily_guidance",
        message,
        next_actions: [],
        adherence_risk: "low",
        escalation_recommended: Boolean(escalationReason),
        escalation_reason: escalationReason,
      },
    };
  }

  const trimmed = args.history.slice(-20);
  const resumed = Boolean(args.resumedSession);

  try {
    const res = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.55,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `The user sent a chat message. Reply with JSON only.

${buildContextPacket({ ctx, history: trimmed, resumedSession: resumed })}

Latest user message:
${latestUser?.content ?? "(none)"}

If red-flag symptoms appear in the latest user message, set escalation_recommended true.`,
        },
      ],
    });
    const raw = res.choices[0]?.message?.content?.trim() || "";
    const structured = parseStructured(raw);
    if (structured) {
      return {
        message: structured.message,
        kind: "chat",
        structured,
        escalate: Boolean(escalationReason) || structured.escalation_recommended,
        escalationReason:
          escalationReason ?? (structured.escalation_recommended ? structured.escalation_reason ?? undefined : undefined),
      };
    }
    const message =
      mockChatReply(args.history, ctx);
    return {
      message,
      kind: "chat",
      escalate: Boolean(escalationReason),
      escalationReason: escalationReason ?? undefined,
    };
  } catch (err) {
    console.warn("[ai] chat reply fallback:", err);
    return {
      message: mockChatReply(args.history, ctx),
      kind: "chat",
      escalate: Boolean(escalationReason),
      escalationReason: escalationReason ?? undefined,
    };
  }
}

// --- Conversation memory ----------------------------------------------------

export interface SummaryResult {
  text: string;
  open_threads: string[];
  last_message_id?: string;
}

function extractOpenThreadsFromSummary(summary: string): string[] {
  const lines = summary.split(/\n/).map((l) => l.replace(/^[-*]\s*/, "").trim()).filter(Boolean);
  return lines.slice(-5).filter((l) => l.length > 8);
}

export async function summarizeConversation(
  messages: ChatMessage[],
  includeOpenThreads = false,
): Promise<SummaryResult | null> {
  if (messages.length === 0) return null;
  const lastMsg = messages[messages.length - 1];
  if (!client) {
    const text = mockSummary(messages);
    return {
      text,
      open_threads: includeOpenThreads ? extractOpenThreadsFromSummary(text) : [],
      last_message_id: lastMsg?.id,
    };
  }

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
            "Summarize this health coaching conversation into 4-6 short bullet points covering: symptoms, adherence, preferences, and open threads to continue next session. Under 120 words. End with a line OPEN_THREADS: followed by 2-4 comma-separated short thread titles.",
        },
        { role: "user", content: transcript },
      ],
    });
    const text = res.choices[0]?.message?.content?.trim() ?? mockSummary(messages);
    let open_threads: string[] = [];
    if (includeOpenThreads) {
      const otMatch = text.match(/OPEN_THREADS:\s*(.+)$/im);
      if (otMatch) {
        open_threads = otMatch[1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 6);
      } else {
        open_threads = extractOpenThreadsFromSummary(text);
      }
    }
    return { text, open_threads, last_message_id: lastMsg?.id };
  } catch {
    const text = mockSummary(messages);
    return {
      text,
      open_threads: includeOpenThreads ? extractOpenThreadsFromSummary(text) : [],
      last_message_id: lastMsg?.id,
    };
  }
}

export async function maybeSummarizeAndSnapshot(
  userId: string,
  messages: ChatMessage[],
): Promise<void> {
  if (messages.length < SUMMARY_EVERY_N || messages.length % SUMMARY_EVERY_N !== 0) return;
  const summary = await summarizeConversation(messages, true);
  if (!summary) return;
  await upsertMemory(userId, summary.text, summary.open_threads, summary.last_message_id);
  const last20 = messages.slice(-20);
  const fromId = last20[0]?.id;
  const toId = last20[last20.length - 1]?.id;
  await appendMemorySnapshot({
    user_id: userId,
    summary: summary.text,
    open_threads: summary.open_threads,
    source_message_from_id: fromId,
    source_message_to_id: toId,
    created_at: new Date().toISOString(),
  });
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
      return `I'm glad you reached out. I've flagged a human clinician to follow up with you. While you wait, is there one thing making today hardest?`;
    case "escalation_triggered":
      return `I've flagged this for a human clinician to review. They'll reach out soon. In the meantime I'm still here — no pressure to explain more unless you want to.`;
    default:
      return `Got it, ${name}. I've updated your plan.`;
  }
}

function mockChatReply(history: ChatMessage[], ctx: CoachContext): string {
  const last = [...history].reverse().find((m) => m.role === "user");
  const name = ctx.user.name.split(" ")[0];
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
  return `Recent exchange:\n${last.join("\n")}\nOPEN_THREADS: medication timing, energy check-in`;
}
