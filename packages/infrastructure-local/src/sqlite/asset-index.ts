import type { AssetType } from '@test-platform/contracts';
import type { AssetSummary, AssetVersionRecord } from '@test-platform/core';
import { transaction, type Database, type Row } from './database.js';

export type AssetIndexEntry = {
  type: AssetType;
  id: string;
  version: number;
  path: string;
  name: string;
  tags: string[];
  contentHash: string;
  updatedAt: string;
};

export type AssetVersionEntry = {
  type: AssetType;
  id: string;
  version: number;
  contentHash: string;
  path: string;
  createdAt: string;
  createdBy: string;
};

const toSummary = (row: Row): AssetSummary => ({
  id: row.id as string,
  type: row.type as AssetType,
  name: row.name as string,
  tags: JSON.parse(row.tags as string) as string[],
  currentVersion: row.current_version as number,
  contentHash: row.content_hash as string,
  updatedAt: row.updated_at as string,
});

/** SQLite index over the JSON definition files (`assets` and `asset_versions`). */
export class SqliteAssetIndex {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Upserts the current row and, when given, the version row in one transaction. */
  record(entry: AssetIndexEntry, version?: AssetVersionEntry): void {
    transaction(this.#db, () => {
      this.#db
        .prepare(
          `INSERT INTO assets (id, type, current_version, path, name, tags, content_hash, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (type, id) DO UPDATE SET current_version = excluded.current_version, path = excluded.path,
             name = excluded.name, tags = excluded.tags, content_hash = excluded.content_hash, updated_at = excluded.updated_at`,
        )
        .run(
          entry.id,
          entry.type,
          entry.version,
          entry.path,
          entry.name,
          JSON.stringify(entry.tags),
          entry.contentHash,
          entry.updatedAt,
        );
      if (version) {
        this.#db
          .prepare(
            `INSERT INTO asset_versions (asset_type, asset_id, version, content_hash, path, created_at, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (asset_type, asset_id, version) DO UPDATE SET content_hash = excluded.content_hash, path = excluded.path`,
          )
          .run(
            version.type,
            version.id,
            version.version,
            version.contentHash,
            version.path,
            version.createdAt,
            version.createdBy,
          );
      }
    });
  }

  /** Adds a version row without touching the current-asset row (used when rebuilding history). */
  recordVersion(version: AssetVersionEntry): void {
    this.#db
      .prepare(
        `INSERT INTO asset_versions (asset_type, asset_id, version, content_hash, path, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (asset_type, asset_id, version) DO NOTHING`,
      )
      .run(
        version.type,
        version.id,
        version.version,
        version.contentHash,
        version.path,
        version.createdAt,
        version.createdBy,
      );
  }

  remove(type: AssetType, id: string): void {
    transaction(this.#db, () => {
      this.#db
        .prepare('DELETE FROM asset_versions WHERE asset_type = ? AND asset_id = ?')
        .run(type, id);
      this.#db.prepare('DELETE FROM assets WHERE type = ? AND id = ?').run(type, id);
    });
  }

  get(type: AssetType, id: string): (AssetSummary & { path: string }) | undefined {
    const row = this.#db.prepare('SELECT * FROM assets WHERE type = ? AND id = ?').get(type, id) as
      Row | undefined;
    return row ? { ...toSummary(row), path: row.path as string } : undefined;
  }

  list(type: AssetType): (AssetSummary & { path: string })[] {
    const rows = this.#db
      .prepare('SELECT * FROM assets WHERE type = ? ORDER BY name COLLATE NOCASE, id')
      .all(type) as Row[];
    return rows.map((row) => ({ ...toSummary(row), path: row.path as string }));
  }

  versions(type: AssetType, id: string): AssetVersionRecord[] {
    const rows = this.#db
      .prepare(
        'SELECT * FROM asset_versions WHERE asset_type = ? AND asset_id = ? ORDER BY version',
      )
      .all(type, id) as Row[];
    return rows.map((row) => ({
      version: row.version as number,
      contentHash: row.content_hash as string,
      createdAt: row.created_at as string,
      createdBy: row.created_by as string,
    }));
  }
}
