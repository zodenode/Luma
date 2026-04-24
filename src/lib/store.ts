import { promises as fs } from "fs";
import path from "path";
import type {
  CareEvent,
  ChatMessage,
  ChatSession,
  ConversationMemory,
  DB,
  EscalationRecord,
  EventType,
  KpiMarker,
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
  kpi_markers: [],
};

let writeLock: Promise<void> = Promise.resolve();

function migrateDB(raw: Partial<DB>): DB {
  const users = (raw.users ?? []).map((u) => ({
    ...u,
    updated_at: u.updated_at ?? u.created_at,
  }));

  const events: CareEvent[] = (raw.events ?? []).map((e) => {
    const occurred = e.occurred_at ?? e.timestamp ?? new Date().toISOString();
    const received = e.received_at ?? e.timestamp ?? occurred;
    const idem =
      e.idempotency_key ??
      (e.payload as { _idempotency_key?: string })?._idempotency_key ??
      `legacy:${e.id}`;
    const payload = { ...e.payload };
    delete (payload as { _idempotency_key?: string })._idempotency_key;
    return {
      ...e,
      occurred_at: occurred,
      received_at: received,
      idempotency_key: idem,
      payload,
    };
  });

  const messages: ChatMessage[] = (raw.messages ?? []).map((m) => {
    const meta = m.meta;
    const metadata = m.metadata ?? (meta ? { ...meta } : {});
    return { ...m, metadata, meta: undefined };
  });

  const memory: ConversationMemory[] = (raw.memory ?? []).map((m) => ({
    ...m,
    open_threads: m.open_threads ?? [],
    last_summarized_message_id: m.last_summarized_message_id,
  }));

  const treatments: TreatmentState[] = (raw.treatments ?? []).map((t) =>
    deriveTreatmentFields(t),
  );

  return {
    users,
    treatments,
    events,
    messages,
    memory,
    memory_snapshots: raw.memory_snapshots ?? [],
    escalations: raw.escalations ?? [],
    chat_sessions: raw.chat_sessions ?? [],
    kpi_markers: raw.kpi_markers ?? [],
  };
}

function deriveTreatmentFields(t: TreatmentState): TreatmentState {
  const med = t.medication;
  let medication_status = t.medication_status;
  if (!medication_status) {
    if (!med || med.state === "none") medication_status = "none";
    else if (med.state === "not_started") medication_status = "prescribed";
    else if (med.state === "shipped") medication_status = "shipped";
    else if (med.state === "delivered" || med.state === "active" || med.state === "refill_due")
      medication_status = "active";
    else medication_status = "none";
  }
  let adherence_indicator = t.adherence_indicator;
  if (!adherence_indicator) {
    const s = t.adherence_score;
    if (s == null) adherence_indicator = "unknown";
    else if (s >= 0.65) adherence_indicator = "good";
    else adherence_indicator = "at_risk";
  }
  return {
    ...t,
    medication_status,
    adherence_indicator,
    key_symptoms: t.key_symptoms?.length ? t.key_symptoms : undefined,
  };
}

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
  const t = db.treatments.find((x) => x.user_id === userId);
  return t ? deriveTreatmentFields(t) : undefined;
}

export async function getEvents(userId: string): Promise<CareEvent[]> {
  const db = await readDB();
  return db.events
    .filter((e) => e.user_id === userId)
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
}

export async function getEventsByIdempotencyKey(
  key: string,
): Promise<CareEvent | undefined> {
  const db = await readDB();
  return db.events.find((e) => e.idempotency_key === key);
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
  const snaps = db.memory_snapshots.filter((s) => s.user_id === userId);
  if (!snaps.length) return undefined;
  return [...snaps].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
}

export async function listEscalations(status?: EscalationRecord["status"]): Promise<
  EscalationRecord[]
> {
  const db = await readDB();
  let list = [...db.escalations];
  if (status) list = list.filter((e) => e.status === status);
  return list.sort((a, b) => b.created_at.localeCompare(a.created_at));
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
    const next = deriveTreatmentFields(updater(base));
    next.updated_at = new Date().toISOString();
    if (idx >= 0) db.treatments[idx] = next;
    else db.treatments.push(next);
    return next;
  });
}

export async function upsertMemory(
  userId: string,
  summary: string,
  openThreads?: string[],
  lastSummarizedMessageId?: string,
): Promise<ConversationMemory> {
  return mutate(async (db) => {
    const idx = db.memory.findIndex((m) => m.user_id === userId);
    const entry: ConversationMemory = {
      user_id: userId,
      summary,
      open_threads: openThreads ?? (idx >= 0 ? db.memory[idx].open_threads : []),
      last_summarized_message_id: lastSummarizedMessageId,
      updated_at: new Date().toISOString(),
    };
    if (idx >= 0) db.memory[idx] = entry;
    else db.memory.push(entry);
    return entry;
  });
}

export async function appendMemorySnapshot(
  snap: Omit<MemorySnapshot, "id">,
): Promise<MemorySnapshot> {
  return mutate(async (db) => {
    const full: MemorySnapshot = { ...snap, id: newId("snap") };
    db.memory_snapshots.push(full);
    return full;
  });
}

export async function appendEscalation(
  rec: Omit<EscalationRecord, "id" | "created_at" | "updated_at">,
): Promise<EscalationRecord> {
  return mutate(async (db) => {
    const now = new Date().toISOString();
    const full: EscalationRecord = {
      ...rec,
      id: newId("esc"),
      created_at: now,
      updated_at: now,
    };
    db.escalations.push(full);
    return full;
  });
}

export async function appendChatSession(
  rec: Omit<ChatSession, "id">,
): Promise<ChatSession> {
  return mutate(async (db) => {
    const full: ChatSession = { ...rec, id: newId("sess") };
    db.chat_sessions.push(full);
    return full;
  });
}

export async function appendKpiMarker(
  marker: Omit<KpiMarker, "id" | "created_at">,
): Promise<void> {
  await mutate(async (db) => {
    db.kpi_markers.push({
      ...marker,
      id: newId("kpi"),
      created_at: new Date().toISOString(),
    });
  });
}

export interface AssistantMessageInput {
  userId: string;
  content: string;
  eventId?: string;
  kind?: NonNullable<ChatMessage["metadata"]>["kind"];
  eventType?: EventType;
  structured?: {
    response_type?: string;
    next_actions?: string[];
    adherence_risk?: "low" | "medium" | "high";
    escalation_recommended?: boolean;
    escalation_reason?: string | null;
  };
}

export async function appendAssistantMessage(
  input: AssistantMessageInput,
): Promise<ChatMessage> {
  return mutate(async (db) => {
    const msg: ChatMessage = {
      id: newId("msg"),
      user_id: input.userId,
      role: "assistant",
      content: input.content,
      created_at: new Date().toISOString(),
      event_id: input.eventId,
      metadata: {
        kind: input.kind ?? "chat",
        eventType: input.eventType,
        response_type: input.structured?.response_type,
        next_actions: input.structured?.next_actions,
        adherence_risk: input.structured?.adherence_risk,
        escalation_recommended: input.structured?.escalation_recommended,
        escalation_reason: input.structured?.escalation_reason ?? undefined,
        linked_event_ids: input.eventId ? [input.eventId] : undefined,
      },
    };
    db.messages.push(msg);
    return msg;
  });
}

export async function appendUserMessage(
  userId: string,
  content: string,
): Promise<ChatMessage> {
  return mutate(async (db) => {
    const msg: ChatMessage = {
      id: newId("msg"),
      user_id: userId,
      role: "user",
      content,
      created_at: new Date().toISOString(),
      metadata: { kind: "chat" },
    };
    db.messages.push(msg);
    return msg;
  });
}
