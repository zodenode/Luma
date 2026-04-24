import { describe, expect, it } from "vitest";
import {
  classifySymptomEscalation,
  mapRequestHelpReason,
  shouldEscalateAdherenceMisses,
} from "./escalation";
import type { CareEvent } from "./types";

function evt(type: CareEvent["type"], at: string): CareEvent {
  return {
    id: "e",
    user_id: "u",
    type,
    source: "user",
    occurred_at: at,
    received_at: at,
    idempotency_key: `${type}:${at}`,
    payload: {},
  };
}

describe("classifySymptomEscalation", () => {
  it("escalates high severity", () => {
    const r = classifySymptomEscalation({ severity: 9, symptom: "pain" });
    expect(r.escalate).toBe(true);
    expect(r.reason).toBe("risk_signal");
  });

  it("escalates chest pain language", () => {
    const r = classifySymptomEscalation({ severity: 2, symptom: "chest pain", note: "" });
    expect(r.escalate).toBe(true);
  });
});

describe("shouldEscalateAdherenceMisses", () => {
  it("returns true after 3 misses in window", () => {
    const now = Date.now();
    const misses = [0, 1, 2].map((i) =>
      evt("adherence_missed", new Date(now - i * 86400000).toISOString()),
    );
    expect(shouldEscalateAdherenceMisses(misses)).toBe(true);
  });
});

describe("mapRequestHelpReason", () => {
  it("maps adherence wording", () => {
    expect(mapRequestHelpReason({ reason: "missed doses" })).toBe("adherence_decline");
  });
});
