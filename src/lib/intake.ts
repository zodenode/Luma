import { mutate } from "./store";
import type { HealthGoal, User } from "./types";
import { newId } from "./id";
import { ingestEvent } from "./events";

export interface IntakeInput {
  name: string;
  goal: HealthGoal;
  symptoms: string[];
  history: string;
}

export async function createIntake(input: IntakeInput): Promise<User> {
  const now = new Date().toISOString();
  const user: User = {
    id: newId("usr"),
    name: input.name.trim(),
    goal: input.goal,
    symptoms: input.symptoms.map((s) => s.trim()).filter(Boolean),
    history: input.history.trim(),
    linked_openloop_id: `ol_${newId().slice(0, 8)}`,
    created_at: now,
    updated_at: now,
  };

  await mutate(async (db) => {
    db.users.push(user);
  });

  await ingestEvent({
    userId: user.id,
    type: "intake_completed",
    source: "user",
    payload: { goal: user.goal, symptoms: user.symptoms },
    idempotency_key: `intake_completed:${user.id}`,
  });

  return user;
}
