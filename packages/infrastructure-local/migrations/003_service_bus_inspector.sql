-- Service Bus Inspector: watches (queues / topic subscriptions that the worker peeks at), the
-- messages collected from them or recorded from Service Bus Steps, and the single "last viewed"
-- marker behind the unread badge. Forward-only. Message bodies and properties are masked before
-- they are stored; nothing here ever holds a credential.

CREATE TABLE sb_inspector_watches (
  id              TEXT PRIMARY KEY,
  environment_id  TEXT NOT NULL,
  target          TEXT NOT NULL,
  entity          TEXT NOT NULL,
  -- '' for a queue, the subscription name for a topic (kept non-null so UNIQUE works).
  subscription    TEXT NOT NULL DEFAULT '',
  source          TEXT NOT NULL CHECK (source IN ('manual', 'step')),
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  -- Last peeked sequence number (64-bit, kept as text); NULL until the first message is seen.
  cursor_sequence TEXT,
  last_polled_at  TEXT,
  last_error_code TEXT,
  last_error_at   TEXT,
  received_count  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (environment_id, target, entity, subscription)
);

CREATE TABLE sb_inspector_messages (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,
  -- Kept (without a foreign key) when a watch is removed, so history survives removal.
  watch_id        TEXT,
  origin          TEXT NOT NULL CHECK (origin IN ('received', 'sent')),
  received_at     TEXT NOT NULL,
  environment_id  TEXT NOT NULL,
  target          TEXT NOT NULL,
  entity          TEXT NOT NULL,
  subscription    TEXT NOT NULL DEFAULT '',
  message_id      TEXT,
  subject         TEXT,
  content_type    TEXT,
  size_bytes      INTEGER NOT NULL DEFAULT 0,
  preview         TEXT NOT NULL DEFAULT '',
  run_id          TEXT,
  -- Service Bus sequence number of a received message; NULL for sent copies.
  sequence_number TEXT,
  -- Full masked message (metadata, properties, body) as JSON.
  detail          TEXT NOT NULL
);

-- A peeked message is stored once per watch, however many times or by whichever worker it is seen.
CREATE UNIQUE INDEX idx_sb_inspector_dedupe
  ON sb_inspector_messages (watch_id, sequence_number)
  WHERE sequence_number IS NOT NULL AND watch_id IS NOT NULL;
CREATE INDEX idx_sb_inspector_watch ON sb_inspector_messages (watch_id, seq);

CREATE TABLE sb_inspector_state (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  last_viewed_seq  INTEGER NOT NULL DEFAULT 0
);
INSERT INTO sb_inspector_state (id, last_viewed_seq) VALUES (1, 0);
