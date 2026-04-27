import { describe, expect, it, beforeEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import { ingestEvent } from "./events";
import { readDB } from "./store";
import type { User } from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "luma.json");

beforeEach(async () => {
  try {
    await fs.unlink(DB_PATH);
  } catch {
    // ignore
  }
});

async function seedUser(): Promise<User> {
  const user: User = {
    id: "usr_test",
    name: "Test User",
    goal: "energy",
    symptoms: [],
    history: "",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { mutate } = await import("./store");
  await mutate(async (db) => {
    db.users.push(user);
    db.treatments.push({
      user_id: user.id,
      stage: "pre_consult",
      risk_flags: [],
      adherence_indicator: "unknown",
      key_symptoms: [],
      updated_at: new Date().toISOString(),
    });
  });
  return user;
}

describe("ingestEvent idempotency", () => {
  it("returns same event for duplicate idempotency key", async () => {
    const user = await seedUser();
    const a = await ingestEvent({
      userId: user.id,
      type: "user_checkin",
      source: "user",
      payload: { channel: "chat" },
      idempotency_key: "same-key",
    });
    const b = await ingestEvent({
      userId: user.id,
      type: "user_checkin",
      source: "user",
      payload: { channel: "chat" },
      idempotency_key: "same-key",
    });
    expect(a.id).toBe(b.id);
    const db = await readDB();
    expect(db.events.filter((e) => e.idempotency_key === "same-key")).toHaveLength(1);
  });
});
