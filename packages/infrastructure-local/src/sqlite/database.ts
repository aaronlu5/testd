import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export type Database = DatabaseSync;
export type SqlValue = SQLInputValue;

export type OpenDatabaseOptions = {
  /** File path, or `:memory:` (not shared between connections). */
  path: string;
  busyTimeoutMs?: number;
};

/** Opens SQLite in WAL mode with a busy timeout so concurrent API/worker processes wait, not fail. */
export const openDatabase = ({ path, busyTimeoutMs = 5000 }: OpenDatabaseOptions): Database => {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = ${Math.trunc(busyTimeoutMs)}`);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
};

const activeTransactions = new WeakSet<Database>();

/** Runs `work` in a BEGIN IMMEDIATE transaction (takes the write lock up front). Not re-entrant. */
export const transaction = <T>(db: Database, work: () => T): T => {
  if (activeTransactions.has(db)) return work();
  db.exec('BEGIN IMMEDIATE');
  activeTransactions.add(db);
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The transaction may already have been rolled back by SQLite.
    }
    throw error;
  } finally {
    activeTransactions.delete(db);
  }
};

export type Row = Record<string, unknown>;

/** node:sqlite rejects `undefined`; normalise to NULL. */
export const bind = (values: readonly (SqlValue | undefined)[]): SqlValue[] =>
  values.map((value) => value ?? null);

export const toJson = (value: unknown): string | null =>
  value === undefined ? null : JSON.stringify(value);

export const fromJson = <T>(value: unknown): T | undefined =>
  typeof value === 'string' ? (JSON.parse(value) as T) : undefined;
