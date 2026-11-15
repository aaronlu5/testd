-- migrate:foreign-keys-off
-- Phase 2: Paused Runs and Step Runs, continuation generations, breakpoint pause records, and
-- Suite Run coordination. Forward-only; existing rows, Run snapshots and Test edge data are copied
-- verbatim.
--
-- SQLite cannot alter a CHECK constraint, so `runs` and `step_runs` are rebuilt using the
-- documented procedure (create new, copy, drop, rename). The migrator runs this file with
-- foreign keys disabled (see the directive above) so dropping the old parent tables does not
-- cascade into jobs, artifacts or step_runs, and verifies PRAGMA foreign_key_check afterwards.

CREATE TABLE runs_new (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL CHECK (kind IN ('test', 'suite')),
  status              TEXT NOT NULL CHECK (status IN ('Queued', 'Running', 'Paused', 'Cancelling', 'Succeeded', 'Failed', 'Cancelled')),
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
  error               TEXT,
  continuation_generation INTEGER NOT NULL DEFAULT 0 CHECK (continuation_generation >= 0),
  paused_at           TEXT
);

INSERT INTO runs_new (id, kind, status, environment_id, requested_by, requested_at, started_at, finished_at,
  cancel_requested_at, parent_run_id, rerun_of_run_id, test_id, test_version, data_set_id, data_set_version,
  suite_id, suite_version, variable_overrides, snapshots, error)
SELECT id, kind, status, environment_id, requested_by, requested_at, started_at, finished_at,
  cancel_requested_at, parent_run_id, rerun_of_run_id, test_id, test_version, data_set_id, data_set_version,
  suite_id, suite_version, variable_overrides, snapshots, error
FROM runs;

DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;

CREATE INDEX idx_runs_status ON runs (status, requested_at);
CREATE INDEX idx_runs_requested_at ON runs (requested_at);
CREATE INDEX idx_runs_test ON runs (test_id);
CREATE INDEX idx_runs_parent ON runs (parent_run_id);

CREATE TABLE step_runs_new (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  node_id        TEXT NOT NULL,
  attempt        INTEGER NOT NULL CHECK (attempt >= 1),
  status         TEXT NOT NULL CHECK (status IN ('Queued', 'Running', 'Paused', 'Succeeded', 'Failed', 'Retrying', 'Skipped', 'Cancelled')),
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

INSERT INTO step_runs_new (id, run_id, node_id, attempt, status, resolved_input, output_preview, error, logs,
  artifacts, started_at, finished_at, duration_ms)
SELECT id, run_id, node_id, attempt, status, resolved_input, output_preview, error, logs,
  artifacts, started_at, finished_at, duration_ms
FROM step_runs;

DROP TABLE step_runs;
ALTER TABLE step_runs_new RENAME TO step_runs;

CREATE INDEX idx_step_runs_run ON step_runs (run_id);

-- One row per Breakpoint pause. A Run may pause several times (at different Breakpoints), but
-- only one pause can be active; `continuation_generation` is unique per Run and guards resume.
CREATE TABLE run_pauses (
  id                          TEXT PRIMARY KEY,
  run_id                      TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  breakpoint_step_run_id      TEXT NOT NULL REFERENCES step_runs (id) ON DELETE CASCADE,
  breakpoint_node_id          TEXT NOT NULL,
  message                     TEXT,
  next_node_id                TEXT,
  next_node_name              TEXT,
  next_node_type              TEXT,
  next_resolved_input_preview TEXT,
  next_input_artifact_id      TEXT REFERENCES artifacts (id) ON DELETE SET NULL,
  paused_at                   TEXT NOT NULL,
  continuation_generation     INTEGER NOT NULL CHECK (continuation_generation >= 0),
  resumed_at                  TEXT,
  cancelled_at                TEXT,
  CHECK (resumed_at IS NULL OR cancelled_at IS NULL),
  UNIQUE (run_id, continuation_generation)
);
CREATE UNIQUE INDEX uq_run_pauses_active ON run_pauses (run_id)
  WHERE resumed_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX idx_run_pauses_step_run ON run_pauses (breakpoint_step_run_id);

-- Suite Run parent. Child Test Runs live in `runs`; `suite_run_items.run_id` links them.
CREATE TABLE suite_runs (
  id                     TEXT PRIMARY KEY,
  status                 TEXT NOT NULL CHECK (status IN ('Queued', 'Running', 'WaitingForBreakpoint', 'Cancelling', 'Succeeded', 'Failed', 'Cancelled')),
  environment_id         TEXT NOT NULL,
  suite_id               TEXT NOT NULL,
  suite_version          INTEGER NOT NULL CHECK (suite_version >= 1),
  requested_by           TEXT NOT NULL,
  requested_at           TEXT NOT NULL,
  started_at             TEXT,
  finished_at            TEXT,
  cancel_requested_at    TEXT,
  rerun_of_suite_run_id  TEXT REFERENCES suite_runs (id),
  max_concurrency        INTEGER NOT NULL CHECK (max_concurrency BETWEEN 1 AND 64),
  variable_overrides     TEXT NOT NULL DEFAULT '{}',
  snapshots              TEXT NOT NULL,
  error                  TEXT
);
CREATE INDEX idx_suite_runs_status ON suite_runs (status, requested_at);
CREATE INDEX idx_suite_runs_requested_at ON suite_runs (requested_at);

CREATE TABLE suite_run_items (
  id               TEXT PRIMARY KEY,
  suite_run_id     TEXT NOT NULL REFERENCES suite_runs (id) ON DELETE CASCADE,
  position         INTEGER NOT NULL CHECK (position >= 0),
  test_id          TEXT NOT NULL,
  test_version     INTEGER NOT NULL CHECK (test_version >= 1),
  data_set_id      TEXT NOT NULL,
  data_set_version INTEGER NOT NULL CHECK (data_set_version >= 1),
  run_id           TEXT UNIQUE REFERENCES runs (id),
  status           TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Queued', 'Running', 'Paused', 'Cancelling', 'Succeeded', 'Failed', 'Cancelled', 'Skipped')),
  dispatched_at    TEXT,
  finished_at      TEXT,
  UNIQUE (suite_run_id, position)
);
CREATE INDEX idx_suite_items_status ON suite_run_items (suite_run_id, status, position);
