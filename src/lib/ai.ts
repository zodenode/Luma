import OpenAI from "openai";
import { getMemory, getTreatment, getUser } from "./store";
import type { CareEvent, ChatMessage, TreatmentState, User } from "./types";

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const hasKey = Boolean(process.env.OPENAI_API_KEY);

const client = hasKey ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

export interface CoachReply {
  message: string;
  kind: "greeting" | "event_followup" | "chat" | "nudge" | "escalation";
  escalate?: boolean;
  escalationReason?: string;
}

const SYSTEM_PROMPT = `You are Luma, a warm, concise AI health coach.
You sit on top of a real telehealth + pharmacy stack (OpenLoop + pharmacy partner).
You interpret clinical events, explain treatment plans in plain language, and keep
users engaged day-to-day.

Ground rules:
- You are NOT a clinician. Never diagnose, prescribe, or change dosing.
- Keep messages short (2-5 sentences). Use one small, specific next action.
- When a user reports red-flag symptoms (chest pain, suicidal ideation, severe
  allergic reaction, pregnancy complications, severe mental health crisis),
  acknowledge, urge them to contact a clinician or emergency services, and flag
  for escalation.
- Reference the user's goal, medication state, and recent events when helpful.
- Never invent clinical facts. If you don't know, say so and suggest asking their clinician.`;

interface CoachContext {
  user: User;
  treatment?: TreatmentState;
  memorySummary?: string;
}

async function loadContext(userId: string): Promise<CoachContext | null> {
  const user = await getUser(userId);
  if (!user) return null;
  const [treatment, memory] = await Promise.all([
    getTreatment(userId),
    getMemory(userId),
  ]);
  return { user, treatment, memorySummary: memory?.summary };
}

function renderContext(ctx: CoachContext): string {
  const { user, treatment, memorySummary } = ctx;
  const lines: string[] = [
    `User: ${user.name} (goal: ${user.goal.replace("_", " ")})`,
  ];
  if (user.symptoms.length) lines.push(`Symptoms reported at intake: ${user.symptoms.join(", ")}`);
  if (user.history) lines.push(`Relevant history: ${user.history}`);
  if (treatment) {
    lines.push(`Treatment stage: ${treatment.stage}`);
    if (treatment.diagnosis) lines.push(`Diagnosis (from clinician): ${treatment.diagnosis}`);
    if (treatment.plan_summary) lines.push(`Plan: ${treatment.plan_summary}`);
    if (treatment.medication) {
      const m = treatment.medication;
      lines.push(
        `Medication: ${m.name}${m.dosage ? ` ${m.dosage}` : ""} — state=${m.state}`,
      );
    }
    if (typeof treatment.adherence_score === "number") {
      lines.push(`Adherence score: ${(treatment.adherence_score * 100).toFixed(0)}%`);
    }
    if (treatment.risk_flags.length) lines.push(`Risk flags: ${treatment.risk_flags.join(", ")}`);
  }
  if (memorySummary) lines.push(`Prior conversation summary: ${memorySummary}`);
  return lines.join("\n");
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

  const kind = event.type === "escalation_triggered" ? "escalation" : "event_followup";

  if (!client) return { message: mockEventFollowup(event, ctx), kind };

  const userPrompt = `A new clinical/system event just arrived for this user.
Write a short, warm coach message (2-4 sentences) that:
1. Acknowledges the event in plain language.
2. Explains what it means for them, tied to their goal.
3. Gives ONE specific next action they can take in the app today.

Event:
${JSON.stringify({ type: event.type, payload: event.payload }, null, 2)}

User context:
${renderContext(ctx)}`;

  try {
    const res = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.5,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    });
    const message = res.choices[0]?.message?.content?.trim();
    if (!message) return { message: mockEventFollowup(event, ctx), kind };
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
}): Promise<CoachReply> {
  const ctx = await loadContext(args.userId);
  if (!ctx) {
    return { message: "I can't find your profile. Please complete intake first.", kind: "chat" };
  }

  const latestUser = [...args.history].reverse().find((m) => m.role === "user");
  const escalationReason = latestUser ? detectRedFlags(latestUser.content) : null;

  if (!client) {
    const reply = mockChatReply(args.history, ctx);
    return {
      message: reply,
      kind: "chat",
      escalate: Boolean(escalationReason),
      escalationReason: escalationReason ?? undefined,
    };
  }

  const contextMsg = renderContext(ctx);
  const trimmed = args.history.slice(-16);

  try {
    const res = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.6,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "system", content: `Current user context:\n${contextMsg}` },
        ...trimmed.map((m) => ({
          role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user",
          content: m.content,
        })) as { role: "user" | "assistant" | "system"; content: string }[],
      ],
    });
    const message = res.choices[0]?.message?.content?.trim() || "I'm here. Tell me more about how you're feeling today.";
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
  return `Recent exchange:\n${last.join("\n")}`;
}
