import { promises as fs } from "fs";
import path from "path";
import type {
  CareEvent,
  ChatMessage,
  ChatSession,
  ConversationMemory,
  DB,
  Escalation,
  KpiEvent,
  MemorySnapshot,
  TreatmentState,
  User,
} from "./types";
import { newId } from "./id";

const DATA_DIR = path.join(process.cwd(), "data");

function getDbPath(): string {
  const env = process.env.LUMA_DB_PATH;
  if (env) {
    return path.isAbsolute(env) ? env : path.join(process.cwd(), env);
  }
  return path.join(DATA_DIR, "luma.json");
}
const CURRENT_SCHEMA = 2;

const emptyDB: DB = {
  schema_version: CURRENT_SCHEMA,
  users: [],
  treatments: [],
  events: [],
  messages: [],
  memory: [],
  memory_snapshots: [],
  escalations: [],
  chat_sessions: [],
  kpi_events: [],
};

let writeLock: Promise<void> = Promise.resolve();

function migrateDB(raw: unknown): DB {
  const parsed = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<DB>;
  const ver = parsed.schema_version ?? 0;
  let db: DB = {
    ...emptyDB,
    ...parsed,
    schema_version: ver,
  };
  if (ver < 1) {
    db = {
      ...db,
      memory_snapshots: [],
      escalations: [],
      chat_sessions: [],
      kpi_events: [],
      schema_version: 1,
    };
    for (const u of db.users) {
      if (!u.updated_at) u.updated_at = u.created_at;
    }
    for (const e of db.events) {
      const et = (e as { type: string }).type;
      if (et === "escalation_triggered") (e as { type: string }).type = "escalation_created";
      if (et === "ai_followup") (e as { type: string }).type = "ai_response_generated";
      if (et === "adherence_confirmed") (e as { type: string }).type = "user_checkin";
      if (!e.occurred_at) e.occurred_at = e.timestamp ?? new Date().toISOString();
      if (!e.received_at) e.received_at = e.occurred_at;
      if (!e.idempotency_key) e.idempotency_key = `legacy:${e.id}`;
    }
    for (const m of db.messages) {
      if (!m.metadata) {
        m.metadata = {};
        if (m.event_id) m.metadata.linked_event_ids = [m.event_id];
        if (m.meta) Object.assign(m.metadata, m.meta);
      }
    }
    for (const mem of db.memory) {
      if (!mem.open_threads) mem.open_threads = [];
      if (mem.last_summarized_message_id === undefined) mem.last_summarized_message_id = null;
    }
    for (const t of db.treatments) {
      const legacy = t as TreatmentState & {
        stage?: string;
        medication?: { name: string; dosage?: string; state: string };
        risk_flags?: string[];
      };
      const legacyStage = String(legacy.stage ?? "");
      if (legacyStage === "intake" || legacyStage === "awaiting_fulfilment") {
        legacy.stage = "pre_consult";
      }
      if (legacyStage === "paused") legacy.stage = "active_treatment";
      if (legacyStage === "escalated") legacy.stage = "active_treatment";
      const med = legacy.medication;
      if (med) {
        legacy.active_medication = { name: med.name, dosage: med.dosage };
        const st = med.state;
        if (st === "not_started" || st === "none") legacy.medication_status = "prescribed";
        else if (st === "delivered" || st === "refill_due") legacy.medication_status = "active";
        else if (st === "shipped") legacy.medication_status = "shipped";
        else if (st === "active") legacy.medication_status = "active";
        else legacy.medication_status = "none";
      } else {
        legacy.active_medication = legacy.active_medication ?? null;
        legacy.medication_status = legacy.medication_status ?? "none";
      }
      if (!legacy.adherence_indicator) {
        const score = legacy.adherence_score;
        legacy.adherence_indicator =
          score == null ? "unknown" : score >= 0.55 ? "good" : "at_risk";
      }
      legacy.key_symptoms = legacy.key_symptoms ?? [];
      legacy.latest_lab_summary = legacy.latest_lab_summary ?? null;
      legacy.last_interaction_at = legacy.last_interaction_at ?? null;
      delete legacy.medication;
      delete legacy.risk_flags;
    }
  }
  if (db.schema_version < 2) {
    db.schema_version = 2;
  }
  return db;
}

async function ensureFile(): Promise<void> {
  const dbPath = getDbPath();
  try {
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    await fs.access(dbPath);
  } catch {
    await fs.writeFile(dbPath, JSON.stringify(emptyDB, null, 2), "utf8");
  }
}

export async function readDB(): Promise<DB> {
  await ensureFile();
  const raw = await fs.readFile(getDbPath(), "utf8");
  try {
    const parsed = JSON.parse(raw) as unknown;
    return migrateDB(parsed);
  } catch {
    return { ...emptyDB };
  }
}

export async function writeDB(db: DB): Promise<void> {
  db.schema_version = CURRENT_SCHEMA;
  await ensureFile();
  const run = async () => {
    const dbPath = getDbPath();
    const tmp = dbPath + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(db, null, 2), "utf8");
    await fs.rename(tmp, dbPath);
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

export async function getEventsByIdempotencyKey(key: string): Promise<CareEvent | undefined> {
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
  const snaps = db.memory_snapshots
    .filter((s) => s.user_id === userId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return snaps[0];
}

export async function listEscalations(filter?: {
  status?: Escalation["status"];
  userId?: string;
}): Promise<Escalation[]> {
  const db = await readDB();
  let list = [...db.escalations];
  if (filter?.status) list = list.filter((e) => e.status === filter.status);
  if (filter?.userId) list = list.filter((e) => e.user_id === filter.userId);
  return list.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function appendKpiEvent(
  userId: string,
  name: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  await mutate(async (db) => {
    const evt: KpiEvent = {
      id: newId("kpi"),
      user_id: userId,
      name,
      occurred_at: new Date().toISOString(),
      payload: payload ?? {},
    };
    db.kpi_events.push(evt);
  });
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
    const next = updater(base);
    next.updated_at = new Date().toISOString();
    if (idx >= 0) db.treatments[idx] = next;
    else db.treatments.push(next);
    return next;
  });
}

export async function upsertMemory(
  userId: string,
  patch: Partial<Pick<ConversationMemory, "summary" | "open_threads" | "last_summarized_message_id">>,
): Promise<ConversationMemory> {
  return mutate(async (db) => {
    const idx = db.memory.findIndex((m) => m.user_id === userId);
    const prev =
      idx >= 0
        ? db.memory[idx]
        : {
            user_id: userId,
            summary: "",
            open_threads: [],
            last_summarized_message_id: null,
            updated_at: new Date().toISOString(),
          };
    const entry: ConversationMemory = {
      ...prev,
      ...patch,
      user_id: userId,
      updated_at: new Date().toISOString(),
    };
    if (idx >= 0) db.memory[idx] = entry;
    else db.memory.push(entry);
    return entry;
  });
}

export async function appendMemorySnapshot(input: Omit<MemorySnapshot, "id">): Promise<MemorySnapshot> {
  return mutate(async (db) => {
    const snap: MemorySnapshot = {
      id: newId("snap"),
      ...input,
    };
    db.memory_snapshots.push(snap);
    return snap;
  });
}

export async function createEscalation(input: {
  userId: string;
  reason_code: Escalation["reason_code"];
  linkedEventId?: string | null;
}): Promise<Escalation> {
  return mutate(async (db) => {
    const esc: Escalation = {
      id: newId("esc"),
      user_id: input.userId,
      reason_code: input.reason_code,
      status: "open",
      linked_event_id: input.linkedEventId ?? null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    db.escalations.push(esc);
    return esc;
  });
}

export async function recordChatSession(input: {
  userId: string;
  rehydrated_snapshot_id: string | null;
}): Promise<ChatSession> {
  return mutate(async (db) => {
    const session: ChatSession = {
      id: newId("ses"),
      user_id: input.userId,
      rehydrated_snapshot_id: input.rehydrated_snapshot_id,
      started_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    };
    db.chat_sessions.push(session);
    return session;
  });
}
