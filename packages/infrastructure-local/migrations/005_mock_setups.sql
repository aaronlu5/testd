-- Mock API setups are a fourth asset type. SQLite cannot alter a CHECK constraint, so the asset
-- index is rebuilt with the wider list (create new, copy, drop, rename). Nothing references it
-- by foreign key. Forward-only.

CREATE TABLE assets_new (
  id            TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('test', 'test-data', 'suite', 'mock-setup')),
  current_version INTEGER NOT NULL CHECK (current_version >= 1),
  path          TEXT NOT NULL,
  name          TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]',
  content_hash  TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (type, id)
);

INSERT INTO assets_new (id, type, current_version, path, name, tags, content_hash, updated_at)
SELECT id, type, current_version, path, name, tags, content_hash, updated_at FROM assets;

DROP TABLE assets;
ALTER TABLE assets_new RENAME TO assets;
CREATE INDEX idx_assets_type_name ON assets (type, name);
