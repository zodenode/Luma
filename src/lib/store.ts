import { promises as fs } from "fs";
import path from "path";
import type {
  AuditLogEntry,
  CareEvent,
  ChatMessage,
  ChatSession,
  ConversationMemory,
  DB,
  Escalation,
  KPIEvent,
  MemorySnapshot,
  TreatmentState,
  User,
} from "./types";
import { newId } from "./id";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "luma.json");

const emptyDB: DB = {
  users: [],
  treatments: [],
  events: [],
  messages: [],
  memory: [],
  memory_snapshots: [],
  escalations: [],
  chat_sessions: [],
  kpi_events: [],
  audit_log: [],
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

function migrateDB(parsed: Partial<DB>): DB {
  const now = new Date().toISOString();
  const users = (parsed.users ?? []).map((u) => ({
    ...u,
    updated_at: u.updated_at ?? u.created_at ?? now,
  }));

  const events: CareEvent[] = (parsed.events ?? []).map((e) => {
    const occurred = e.occurred_at ?? e.timestamp ?? now;
    const received = e.received_at ?? e.timestamp ?? now;
    return {
      ...e,
      occurred_at: occurred,
      received_at: received,
      idempotency_key: e.idempotency_key ?? `legacy:${e.id}`,
      source: e.source ?? "system",
    };
  });

  const memory: ConversationMemory[] = (parsed.memory ?? []).map((m) => ({
    ...m,
    open_threads: m.open_threads ?? [],
  }));

  return {
    users,
    treatments: parsed.treatments ?? [],
    events,
    messages: parsed.messages ?? [],
    memory,
    memory_snapshots: parsed.memory_snapshots ?? [],
    escalations: parsed.escalations ?? [],
    chat_sessions: parsed.chat_sessions ?? [],
    kpi_events: parsed.kpi_events ?? [],
    audit_log: parsed.audit_log ?? [],
  };
}

export async function readDB(): Promise<DB> {
  await ensureFile();
  const raw = await fs.readFile(DB_PATH, "utf8");
  try {
    const parsed = JSON.parse(raw) as Partial<DB>;
    return migrateDB(parsed);
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
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
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

export async function getLatestMemorySnapshot(
  userId: string,
): Promise<MemorySnapshot | undefined> {
  const db = await readDB();
  return db.memory_snapshots
    .filter((s) => s.user_id === userId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
}

export async function getEscalations(
  userId?: string,
  status?: Escalation["status"],
): Promise<Escalation[]> {
  const db = await readDB();
  return db.escalations
    .filter((e) => (userId ? e.user_id === userId : true))
    .filter((e) => (status ? e.status === status : true))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function appendAuditLog(entry: Omit<AuditLogEntry, "id" | "created_at">): Promise<void> {
  await mutate(async (db) => {
    db.audit_log.push({
      id: newId("aud"),
      created_at: new Date().toISOString(),
      ...entry,
    });
  });
}

export async function appendKPIEvent(
  userId: string,
  type: KPIEvent["type"],
  payload: Record<string, unknown>,
): Promise<void> {
  await mutate(async (db) => {
    db.kpi_events.push({
      id: newId("kpi"),
      user_id: userId,
      type,
      payload,
      created_at: new Date().toISOString(),
    });
  });
}

export async function hasKPIEvent(userId: string, type: KPIEvent["type"]): Promise<boolean> {
  const db = await readDB();
  return db.kpi_events.some((k) => k.user_id === userId && k.type === type);
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
            adherence_indicator: "unknown",
            key_symptoms: [],
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
  openThreads: string[],
  lastSummarizedMessageId?: string,
): Promise<ConversationMemory> {
  return mutate(async (db) => {
    const idx = db.memory.findIndex((m) => m.user_id === userId);
    const entry: ConversationMemory = {
      user_id: userId,
      summary,
      open_threads: openThreads,
      last_summarized_message_id: lastSummarizedMessageId,
      updated_at: new Date().toISOString(),
    };
    if (idx >= 0) db.memory[idx] = entry;
    else db.memory.push(entry);
    return entry;
  });
}

export async function appendMemorySnapshot(
  snapshot: Omit<MemorySnapshot, "id" | "created_at">,
): Promise<MemorySnapshot> {
  return mutate(async (db) => {
    const row: MemorySnapshot = {
      id: newId("snap"),
      created_at: new Date().toISOString(),
      ...snapshot,
    };
    db.memory_snapshots.push(row);
    return row;
  });
}

export async function createEscalation(input: {
  userId: string;
  reasonCode: Escalation["reason_code"];
  linkedEventId?: string;
}): Promise<Escalation> {
  return mutate(async (db) => {
    const now = new Date().toISOString();
    const row: Escalation = {
      id: newId("esc"),
      user_id: input.userId,
      reason_code: input.reasonCode,
      status: "open",
      linked_event_id: input.linkedEventId,
      created_at: now,
      updated_at: now,
    };
    db.escalations.push(row);
    return row;
  });
}

export async function updateEscalation(
  id: string,
  patch: Partial<Pick<Escalation, "status">>,
): Promise<Escalation | undefined> {
  return mutate(async (db) => {
    const idx = db.escalations.findIndex((e) => e.id === id);
    if (idx < 0) return undefined;
    const next = { ...db.escalations[idx], ...patch, updated_at: new Date().toISOString() };
    db.escalations[idx] = next;
    return next;
  });
}

export async function appendChatSession(row: Omit<ChatSession, "id">): Promise<ChatSession> {
  return mutate(async (db) => {
    const session: ChatSession = { id: newId("ses"), ...row };
    db.chat_sessions.push(session);
    return session;
  });
}

export async function findEventByIdempotencyKey(
  key: string,
): Promise<CareEvent | undefined> {
  const db = await readDB();
  return db.events.find((e) => e.idempotency_key === key);
}
