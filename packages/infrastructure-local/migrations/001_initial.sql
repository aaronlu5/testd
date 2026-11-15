-- Phase 1 initial schema. Timestamps are UTC ISO-8601 strings with millisecond precision
-- (lexicographic order equals chronological order); JSON columns hold serialized JSON.

CREATE TABLE assets (
  id            TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('test', 'test-data', 'suite')),
  current_version INTEGER NOT NULL CHECK (current_version >= 1),
  path          TEXT NOT NULL,
  name          TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]',
  content_hash  TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (type, id)
);
CREATE INDEX idx_assets_type_name ON assets (type, name);

CREATE TABLE asset_versions (
  asset_type    TEXT NOT NULL,
  asset_id      TEXT NOT NULL,
  version       INTEGER NOT NULL CHECK (version >= 1),
  content_hash  TEXT NOT NULL,
  path          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  PRIMARY KEY (asset_type, asset_id, version)
);

CREATE TABLE runs (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL CHECK (kind IN ('test', 'suite')),
  status              TEXT NOT NULL CHECK (status IN ('Queued', 'Running', 'Cancelling', 'Succeeded', 'Failed', 'Cancelled')),
  environment_id      TEXT NOT NULL,
  requested_by        TEXT NOT NULL,
  requested_at        TEXT NOT NULL,
  started_at          TEXT,
  finished_at         TEXT,
  cancel_requested_at TEXT,
  parent_run_id       TEXT REFERENCES runs (id),
  rerun_of_run_id     TEXT REFERENCES runs (id),
  test_id             TEXT,
  test_version        INTEGER,
  data_set_id         TEXT,
  data_set_version    INTEGER,
  suite_id            TEXT,
  suite_version       INTEGER,
  variable_overrides  TEXT NOT NULL DEFAULT '{}',
  snapshots           TEXT NOT NULL,
  error               TEXT
);
CREATE INDEX idx_runs_status ON runs (status, requested_at);
CREATE INDEX idx_runs_requested_at ON runs (requested_at);
CREATE INDEX idx_runs_test ON runs (test_id);
CREATE INDEX idx_runs_parent ON runs (parent_run_id);

CREATE TABLE step_runs (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  node_id        TEXT NOT NULL,
  attempt        INTEGER NOT NULL CHECK (attempt >= 1),
  status         TEXT NOT NULL CHECK (status IN ('Queued', 'Running', 'Succeeded', 'Failed', 'Retrying', 'Skipped', 'Cancelled')),
  resolved_input TEXT,
  output_preview TEXT,
  error          TEXT,
  logs           TEXT NOT NULL DEFAULT '[]',
  artifacts      TEXT NOT NULL DEFAULT '[]',
  started_at     TEXT,
  finished_at    TEXT,
  duration_ms    INTEGER,
  UNIQUE (run_id, node_id, attempt)
);
CREATE INDEX idx_step_runs_run ON step_runs (run_id);

CREATE TABLE jobs (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  status           TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'completed', 'failed', 'cancelled')),
  available_at     TEXT NOT NULL,
  lease_owner      TEXT,
  lease_expires_at TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  last_error       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_jobs_claim ON jobs (status, available_at, created_at);
CREATE INDEX idx_jobs_lease ON jobs (status, lease_expires_at);
CREATE INDEX idx_jobs_run ON jobs (run_id);

CREATE TABLE artifacts (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  step_run_id  TEXT NOT NULL REFERENCES step_runs (id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256       TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_artifacts_step_run ON artifacts (step_run_id);

CREATE TABLE audit_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  at          TEXT NOT NULL,
  metadata    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_audit_entity ON audit_events (entity_type, entity_id);

-- Cross-process live-progress feed: the worker appends, the API streams via polling.
CREATE TABLE run_events (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id  TEXT NOT NULL,
  type    TEXT NOT NULL,
  at      TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX idx_run_events_run ON run_events (run_id, seq);
