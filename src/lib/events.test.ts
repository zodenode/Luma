import { describe, expect, it } from "vitest";
import { reduceTreatment } from "./events";
import type { CareEvent, TreatmentState } from "./types";

function baseTreatment(): TreatmentState {
  return {
    user_id: "u1",
    stage: "pre_consult",
    risk_flags: [],
    updated_at: new Date().toISOString(),
  };
}

function evt(type: CareEvent["type"], payload: Record<string, unknown> = {}): CareEvent {
  const now = new Date().toISOString();
  return {
    id: "evt_test",
    user_id: "u1",
    type,
    source: "openloop",
    occurred_at: now,
    received_at: now,
    idempotency_key: `test:${type}:${Math.random()}`,
    payload,
  };
}

describe("reduceTreatment", () => {
  it("sets post_consult on consult_completed", () => {
    const next = reduceTreatment(baseTreatment(), evt("consult_completed", { diagnosis: "X" }));
    expect(next.stage).toBe("post_consult");
    expect(next.diagnosis).toBe("X");
  });

  it("tracks high severity symptom flag", () => {
    const next = reduceTreatment(
      baseTreatment(),
      evt("symptom_reported", { symptom: "pain", severity: 9 }),
    );
    expect(next.risk_flags).toContain("high_severity_symptom");
  });
});
