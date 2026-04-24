-- AI Coaching MVP — Postgres schema (from engineering plan §5A)
-- Apply with: psql $DATABASE_URL -f db/migrations/001_initial.sql

CREATE TYPE treatment_stage AS ENUM ('pre_consult', 'post_consult', 'active_treatment');
CREATE TYPE medication_status AS ENUM ('none', 'prescribed', 'shipped', 'active');
CREATE TYPE adherence_indicator AS ENUM ('unknown', 'good', 'at_risk');
CREATE TYPE message_role AS ENUM ('user', 'assistant', 'system');

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  linked_openloop_id TEXT UNIQUE,
  goal TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE treatment_states (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stage treatment_stage NOT NULL DEFAULT 'pre_consult',
  active_medication JSONB,
  medication_status medication_status NOT NULL DEFAULT 'none',
  adherence_indicator adherence_indicator NOT NULL DEFAULT 'unknown',
  adherence_score NUMERIC(5,4) CHECK (adherence_score IS NULL OR (adherence_score >= 0 AND adherence_score <= 1)),
  key_symptoms JSONB NOT NULL DEFAULT '[]'::jsonb,
  latest_lab_summary TEXT,
  next_recommended_action TEXT,
  last_interaction_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  idempotency_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE messages (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role message_role NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE conversation_memory (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  summary TEXT NOT NULL DEFAULT '',
  open_threads JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_summarized_message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE memory_snapshots (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  open_threads JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_message_from_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  source_message_to_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE escalations (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  linked_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE chat_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rehydrated_snapshot_id BIGINT REFERENCES memory_snapshots(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_user_occurred_at ON events(user_id, occurred_at DESC);
CREATE INDEX idx_events_type_occurred_at ON events(type, occurred_at DESC);
CREATE INDEX idx_messages_user_created_at ON messages(user_id, created_at DESC);
CREATE INDEX idx_memory_snapshots_user_created_at ON memory_snapshots(user_id, created_at DESC);
CREATE INDEX idx_escalations_user_status_created_at ON escalations(user_id, status, created_at DESC);
CREATE INDEX idx_chat_sessions_user_last_seen ON chat_sessions(user_id, last_seen_at DESC);
CREATE INDEX idx_treatment_states_last_interaction ON treatment_states(last_interaction_at DESC);
