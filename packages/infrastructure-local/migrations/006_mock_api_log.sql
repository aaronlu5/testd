-- What the Mock API server received and answered, and whether the worker is serving it. The
-- worker writes both; the API only reads (and clears the log). Request bodies and responses are
-- masked and size-capped before they are stored, and the log keeps the newest rows only.

CREATE TABLE mock_api_requests (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  at                     TEXT NOT NULL,
  method                 TEXT NOT NULL,
  path                   TEXT NOT NULL,
  query                  TEXT NOT NULL DEFAULT '',
  request_headers        TEXT NOT NULL DEFAULT '{}',
  request_body           TEXT,
  request_body_truncated INTEGER NOT NULL DEFAULT 0,
  status                 INTEGER NOT NULL,
  matched                INTEGER NOT NULL,
  setup_id               TEXT,
  setup_name             TEXT,
  rule_number            INTEGER,
  rule_name              TEXT,
  response_body          TEXT
);

-- A single row (id 1): the worker refreshes it every few seconds while the server is up.
CREATE TABLE mock_api_state (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  listening    INTEGER NOT NULL,
  host         TEXT,
  port         INTEGER,
  started_at   TEXT,
  heartbeat_at TEXT NOT NULL,
  active_runs  INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);
