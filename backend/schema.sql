-- SQLite-oriented schema for care engine MVP (mirrors SQLAlchemy models).

CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(36) PRIMARY KEY,
    external_id VARCHAR(255) UNIQUE,
    created_at DATETIME
);

CREATE TABLE IF NOT EXISTS events (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL REFERENCES users(id),
    event_type VARCHAR(128) NOT NULL,
    timestamp DATETIME NOT NULL,
    payload JSON NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS ix_events_user_id ON events (user_id);
CREATE INDEX IF NOT EXISTS ix_events_event_type ON events (event_type);
CREATE INDEX IF NOT EXISTS ix_events_timestamp ON events (timestamp);

CREATE TABLE IF NOT EXISTS user_state (
    user_id VARCHAR(36) PRIMARY KEY REFERENCES users(id),
    adherence_score FLOAT NOT NULL DEFAULT 1.0,
    risk_level VARCHAR(32) NOT NULL DEFAULT 'low',
    active_treatment_status VARCHAR(64) NOT NULL DEFAULT 'none',
    last_lab_summary TEXT,
    last_interaction_at DATETIME,
    updated_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT 1,
    definition JSON NOT NULL,
    created_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS actions_log (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL REFERENCES users(id),
    event_id VARCHAR(36) REFERENCES events(id),
    rule_id VARCHAR(36) REFERENCES rules(id),
    action_type VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'completed',
    detail JSON NOT NULL DEFAULT '{}',
    created_at DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_actions_log_user_id ON actions_log (user_id);
CREATE INDEX IF NOT EXISTS ix_actions_log_action_type ON actions_log (action_type);
