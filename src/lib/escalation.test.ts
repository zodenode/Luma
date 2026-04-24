import { describe, expect, it } from "vitest";
import { evaluateSymptomEscalation } from "./escalation";

describe("evaluateSymptomEscalation", () => {
  it("escalates high severity", () => {
    const res = evaluateSymptomEscalation({
      id: "e1",
      user_id: "u1",
      type: "symptom_reported",
      source: "user",
      occurred_at: new Date().toISOString(),
      received_at: new Date().toISOString(),
      idempotency_key: "k1",
      payload: { severity: 9 },
    });
    expect(res.shouldEscalate).toBe(true);
    expect(res.reason_code).toBe("risk_signal");
  });

  it("does not escalate low severity", () => {
    const res = evaluateSymptomEscalation({
      id: "e2",
      user_id: "u1",
      type: "symptom_reported",
      source: "user",
      occurred_at: new Date().toISOString(),
      received_at: new Date().toISOString(),
      idempotency_key: "k2",
      payload: { severity: 3 },
    });
    expect(res.shouldEscalate).toBe(false);
  });
});
