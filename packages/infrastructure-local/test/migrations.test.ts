import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate, openDatabase } from '../src/index.js';
import { cleanupAll, makeTempDir, openMigrated } from './helpers.js';

afterEach(cleanupAll);

const tables = (db: ReturnType<typeof openDatabase>): string[] =>
  (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);

describe('migrations', () => {
  it('creates every table named in the technical design plus the event feed', async () => {
    const { db } = await openMigrated();
    expect(tables(db)).toEqual(
      [
        'artifacts',
        'asset_versions',
        'assets',
        'audit_events',
        'jobs',
        'mock_api_requests',
        'mock_api_state',
        'run_events',
        'run_pauses',
        'runs',
        'sb_inspector_messages',
        'sb_inspector_state',
        'sb_inspector_watches',
        'schema_migrations',
        'step_runs',
        'suite_run_items',
        'suite_runs',
      ].sort(),
    );
  });

  it('is idempotent and records checksums', async () => {
    const { db } = await openMigrated();
    expect(migrate(db)).toEqual({ applied: [], currentVersion: 6 });
    const row = db.prepare('SELECT version, name, checksum FROM schema_migrations').get() as {
      checksum: string;
    };
    expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uses WAL mode, a busy timeout, and foreign keys', async () => {
    const { db } = await openMigrated();
    expect((db.prepare('PRAGMA journal_mode').get() as Record<string, string>).journal_mode).toBe(
      'wal',
    );
    expect(
      Number((db.prepare('PRAGMA busy_timeout').get() as Record<string, number>).timeout),
    ).toBe(5000);
    expect(
      Number((db.prepare('PRAGMA foreign_keys').get() as Record<string, number>).foreign_keys),
    ).toBe(1);
  });

  it('refuses a migration whose content changed after it was applied', async () => {
    const { db } = await openMigrated();
    const [initial] = loadMigrations();
    expect(() =>
      migrate(db, [{ ...initial!, sql: `${initial!.sql}\n-- edited`, checksum: 'different' }]),
    ).toThrow('modified after it was applied');
  });

  it('refuses a database that is newer than the application', async () => {
    const { db } = await openMigrated();
    db.prepare(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (99, 'future', 'x', 'now')",
    ).run();
    expect(() => migrate(db)).toThrow('newer than this application');
  });

  it('applies new migrations forward and rolls back a failing one atomically', async () => {
    const dir = await makeTempDir();
    const migrationsDir = join(dir, 'migrations');
    await mkdir(migrationsDir);
    await writeFile(join(migrationsDir, '001_a.sql'), 'CREATE TABLE a (id INTEGER);');
    await writeFile(
      join(migrationsDir, '002_b.sql'),
      'CREATE TABLE b (id INTEGER); INSERT INTO missing_table VALUES (1);',
    );

    const db = openDatabase({ path: join(dir, 'db.sqlite') });
    try {
      expect(() => migrate(db, loadMigrations(migrationsDir))).toThrow();
      expect(tables(db)).toContain('a');
      expect(tables(db)).not.toContain('b');
      expect(
        (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v,
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  it('requires contiguous, well-named migration files', async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, '001_a.sql'), 'SELECT 1;');
    await writeFile(join(dir, '003_c.sql'), 'SELECT 1;');
    expect(() => loadMigrations(dir)).toThrow('contiguous');
    await writeFile(join(dir, 'bad name.sql'), 'SELECT 1;');
    expect(() => loadMigrations(dir)).toThrow('must be named');
  });
});
