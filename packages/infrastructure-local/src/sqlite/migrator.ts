import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlatformError } from '@test-platform/core';
import { transaction, type Database, type Row } from './database.js';

export type Migration = { version: number; name: string; sql: string; checksum: string };

// Works from both src/sqlite (tests) and dist/sqlite (build): the folder sits at the package root.
export const DEFAULT_MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);

const FILE_PATTERN = /^(\d{3,})_([a-z0-9_]+)\.sql$/;

export const loadMigrations = (directory: URL | string = DEFAULT_MIGRATIONS_DIR): Migration[] => {
  const root = typeof directory === 'string' ? directory : fileURLToPath(directory);
  const files = readdirSync(root).filter((file) => file.endsWith('.sql'));
  const migrations = files
    .map((file) => {
      const match = FILE_PATTERN.exec(file);
      if (!match) throw new Error(`Migration file "${file}" must be named NNN_description.sql.`);
      const sql = readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n');
      return {
        version: Number(match[1]),
        name: match[2] as string,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    })
    .sort((a, b) => a.version - b.version);

  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `Migration versions must be contiguous from 001; found ${migration.version} at position ${index + 1}.`,
      );
    }
  });
  return migrations;
};

export type MigrationResult = { applied: number[]; currentVersion: number };

/** First-line directive for table-rebuild migrations that must run with foreign keys disabled. */
const FOREIGN_KEYS_OFF = /^-- migrate:foreign-keys-off[ \t]*(?:\n|$)/;

const applyMigration = (
  db: Database,
  migration: Migration,
  now: () => Date,
  applied: number[],
  verifyForeignKeys: boolean,
): void => {
  transaction(db, () => {
    const existing = db
      .prepare('SELECT checksum FROM schema_migrations WHERE version = ?')
      .get(migration.version) as Row | undefined;
    if (existing) {
      if (existing.checksum !== migration.checksum) {
        throw new PlatformError(
          'SYSTEM_INTERNAL',
          `Migration ${migration.version} (${migration.name}) was modified after it was applied.`,
        );
      }
      return;
    }
    db.exec(migration.sql);
    if (verifyForeignKeys) {
      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length > 0) {
        throw new PlatformError(
          'SYSTEM_INTERNAL',
          `Migration ${migration.version} (${migration.name}) left ${violations.length} foreign key violation(s); it was rolled back.`,
        );
      }
    }
    db.prepare(
      'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
    ).run(migration.version, migration.name, migration.checksum, now().toISOString());
    applied.push(migration.version);
  });
};

/**
 * Applies pending migrations in order. Forward-only: applied migrations must be unchanged
 * (checksum), and a database newer than this code is refused rather than downgraded.
 * Each migration runs in its own IMMEDIATE transaction, which doubles as the cross-process lock.
 */
export const migrate = (
  db: Database,
  migrations: Migration[] = loadMigrations(),
  now: () => Date = () => new Date(),
): MigrationResult => {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    checksum   TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const applied: number[] = [];
  for (const migration of migrations) {
    // PRAGMA foreign_keys is a no-op inside a transaction, so it is toggled around it.
    const foreignKeysOff = FOREIGN_KEYS_OFF.test(migration.sql);
    const priorForeignKeys = foreignKeysOff
      ? Number((db.prepare('PRAGMA foreign_keys').get() as Row).foreign_keys)
      : 1;
    if (foreignKeysOff && priorForeignKeys === 1) db.exec('PRAGMA foreign_keys = OFF');
    try {
      applyMigration(db, migration, now, applied, foreignKeysOff);
    } finally {
      if (foreignKeysOff && priorForeignKeys === 1) db.exec('PRAGMA foreign_keys = ON');
    }
  }

  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as Row;
  const currentVersion = Number(row.version ?? 0);
  const known = migrations.at(-1)?.version ?? 0;
  if (currentVersion > known) {
    throw new PlatformError(
      'SYSTEM_INTERNAL',
      `Database schema version ${currentVersion} is newer than this application supports (${known}).`,
    );
  }
  return { applied, currentVersion };
};
