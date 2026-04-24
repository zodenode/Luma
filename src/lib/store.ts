import { promises as fs } from "fs";
import path from "path";
import type {
  CareEvent,
  ChatMessage,
  ConversationMemory,
  DB,
  TreatmentState,
  User,
} from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "luma.json");

const emptyDB: DB = {
  users: [],
  treatments: [],
  events: [],
  messages: [],
  memory: [],
};

let writeLock: Promise<void> = Promise.resolve();

async function ensureFile(): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.access(DB_PATH);
  } catch {
    await fs.writeFile(DB_PATH, JSON.stringify(emptyDB, null, 2), "utf8");
  }
}

export async function readDB(): Promise<DB> {
  await ensureFile();
  const raw = await fs.readFile(DB_PATH, "utf8");
  try {
    const parsed = JSON.parse(raw) as Partial<DB>;
    return {
      users: parsed.users ?? [],
      treatments: parsed.treatments ?? [],
      events: parsed.events ?? [],
      messages: parsed.messages ?? [],
      memory: parsed.memory ?? [],
    };
  } catch {
    return { ...emptyDB };
  }
}

export async function writeDB(db: DB): Promise<void> {
  await ensureFile();
  const run = async () => {
    const tmp = DB_PATH + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(db, null, 2), "utf8");
    await fs.rename(tmp, DB_PATH);
  };
  writeLock = writeLock.then(run, run);
  await writeLock;
}

export async function mutate<T>(fn: (db: DB) => Promise<T> | T): Promise<T> {
  const db = await readDB();
  const result = await fn(db);
  await writeDB(db);
  return result;
}

// -- helpers -----------------------------------------------------------------

export async function getUser(userId: string): Promise<User | undefined> {
  const db = await readDB();
  return db.users.find((u) => u.id === userId);
}

export async function listUsers(): Promise<User[]> {
  const db = await readDB();
  return [...db.users].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function getTreatment(userId: string): Promise<TreatmentState | undefined> {
  const db = await readDB();
  return db.treatments.find((t) => t.user_id === userId);
}

export async function getEvents(userId: string): Promise<CareEvent[]> {
  const db = await readDB();
  return db.events
    .filter((e) => e.user_id === userId)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export async function getMessages(userId: string): Promise<ChatMessage[]> {
  const db = await readDB();
  return db.messages
    .filter((m) => m.user_id === userId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function getMemory(userId: string): Promise<ConversationMemory | undefined> {
  const db = await readDB();
  return db.memory.find((m) => m.user_id === userId);
}

export async function upsertTreatment(
  userId: string,
  updater: (prev: TreatmentState) => TreatmentState,
): Promise<TreatmentState> {
  return mutate(async (db) => {
    const idx = db.treatments.findIndex((t) => t.user_id === userId);
    const base: TreatmentState =
      idx >= 0
        ? db.treatments[idx]
        : {
            user_id: userId,
            stage: "intake",
            risk_flags: [],
            updated_at: new Date().toISOString(),
          };
    const next = updater(base);
    next.updated_at = new Date().toISOString();
    if (idx >= 0) db.treatments[idx] = next;
    else db.treatments.push(next);
    return next;
  });
}

export async function upsertMemory(
  userId: string,
  summary: string,
): Promise<ConversationMemory> {
  return mutate(async (db) => {
    const idx = db.memory.findIndex((m) => m.user_id === userId);
    const entry: ConversationMemory = {
      user_id: userId,
      summary,
      updated_at: new Date().toISOString(),
    };
    if (idx >= 0) db.memory[idx] = entry;
    else db.memory.push(entry);
    return entry;
  });
}
