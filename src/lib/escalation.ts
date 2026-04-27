import { getEvents } from "./store";
import type { CareEvent, EscalationReasonCode } from "./types";

const MISSED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MISSED_THRESHOLD = 3;

const HIGH_SEVERITY = 8;

const RISK_KEYWORDS: { re: RegExp; reason: EscalationReasonCode }[] = [
  { re: /\b(chest pain|can'?t breathe|shortness of breath)\b/i, reason: "risk_signal" },
  { re: /\b(suicid|kill myself|end my life|self[- ]harm)\b/i, reason: "risk_signal" },
  { re: /\b(anaphylax|swelling of (my )?throat|severe rash)\b/i, reason: "risk_signal" },
  { re: /\b(severe bleeding|passing out|lost consciousness)\b/i, reason: "risk_signal" },
];

export function classifySymptomEscalation(payload: Record<string, unknown>): {
  escalate: boolean;
  reason: EscalationReasonCode;
} {
  const severity = Number(payload.severity ?? 0);
  const text = `${payload.symptom ?? ""} ${payload.note ?? ""}`.toLowerCase();
  for (const { re, reason } of RISK_KEYWORDS) {
    if (re.test(text)) return { escalate: true, reason };
  }
  if (severity >= HIGH_SEVERITY) return { escalate: true, reason: "risk_signal" };
  return { escalate: false, reason: "other" };
}

export function shouldEscalateAdherenceMisses(events: CareEvent[]): boolean {
  const cutoff = Date.now() - MISSED_WINDOW_MS;
  const misses = events.filter(
    (e) => e.type === "adherence_missed" && new Date(e.occurred_at).getTime() >= cutoff,
  );
  return misses.length >= MISSED_THRESHOLD;
}

export function mapRequestHelpReason(payload: Record<string, unknown>): EscalationReasonCode {
  const r = String(payload.reason ?? "").toLowerCase();
  if (/adheren|dose|miss/.test(r)) return "adherence_decline";
  return "user_request";
}
