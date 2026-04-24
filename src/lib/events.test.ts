import { describe, expect, it, beforeEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import { ingestEvent, reduceTreatment } from "./events";
import type { CareEvent, TreatmentState } from "./types";

const DB_PATH = path.join(process.cwd(), "data", "luma-test.json");

beforeEach(async () => {
  try {
    await fs.unlink(DB_PATH);
  } catch {
    /* ignore */
  }
  process.env.LUMA_DB_PATH = DB_PATH;
});

describe("reduceTreatment", () => {
  const base: TreatmentState = {
    user_id: "u1",
    stage: "pre_consult",
    active_medication: null,
    medication_status: "none",
    adherence_indicator: "unknown",
    adherence_score: null,
    key_symptoms: [],
    latest_lab_summary: null,
    next_recommended_action: null,
    last_interaction_at: null,
    updated_at: new Date().toISOString(),
  };

  it("moves to post_consult on consult_completed", () => {
    const ev: CareEvent = {
      id: "evt",
      user_id: "u1",
      type: "consult_completed",
      source: "openloop",
      occurred_at: "2026-04-24T12:00:00Z",
      received_at: "2026-04-24T12:00:01Z",
      idempotency_key: "k",
      payload: { diagnosis: "X", plan_summary: "Y" },
    };
    const next = reduceTreatment(base, ev);
    expect(next.stage).toBe("post_consult");
    expect(next.diagnosis).toBe("X");
  });
});

describe("ingestEvent idempotency", () => {
  it("returns same event for duplicate idempotency key", async () => {
    const { createIntake } = await import("./intake");

    const user = await createIntake({
      name: "Test User",
      goal: "energy",
      symptoms: [],
      history: "",
    });

    const first = await ingestEvent({
      userId: user.id,
      type: "user_checkin",
      source: "user",
      payload: {},
      idempotency_key: "idem:dup:1",
    });
    const second = await ingestEvent({
      userId: user.id,
      type: "user_checkin",
      source: "user",
      payload: {},
      idempotency_key: "idem:dup:1",
    });
    expect(second.id).toBe(first.id);
  });
});
