import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate, openDatabase, type Database } from '../src/index.js';
import { cleanupAll, makeTempDir, onCleanup } from './helpers.js';

afterEach(cleanupAll);

type Row = Record<string, unknown>;
const all = (db: Database, sql: string, ...params: (string | number)[]): Row[] =>
  db.prepare(sql).all(...params) as Row[];
const pragma = (db: Database, name: string): number =>
  Number(Object.values(db.prepare(`PRAGMA ${name}`).get() as Row)[0]);

/** A database exactly as Phase 1 left it: only migration 001 applied, with populated tables. */
const openPhase1Database = async (): Promise<Database> => {
  const dir = await makeTempDir();
  const db = openDatabase({ path: join(dir, 'platform.db') });
  onCleanup(() => {
    try {
      db.close();
    } catch {
      // closed by the test
    }
  });
  const [initial] = loadMigrations();
  migrate(db, [initial!]);

  const snapshots = JSON.stringify({
    environment: { id: 'local-example', name: 'Local', classification: 'TEST', targets: {} },
    test: { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }] },
  });
  for (const [id, status] of [
    ['r-queued', 'Queued'],
    ['r-running', 'Running'],
    ['r-done', 'Succeeded'],
  ] as const) {
    db.prepare(
      `INSERT INTO runs (id, kind, status, environment_id, requested_by, requested_at, variable_overrides, snapshots)
       VALUES (?, 'test', ?, 'local-example', 'tester', '2026-01-01T00:00:00.000Z', '{"k":1}', ?)`,
    ).run(id, status, snapshots);
  }
  db.prepare(
    `INSERT INTO runs (id, kind, status, environment_id, requested_by, requested_at, parent_run_id, snapshots)
     VALUES ('r-child', 'test', 'Queued', 'local-example', 'tester', '2026-01-01T00:00:00.000Z', 'r-done', ?)`,
  ).run(snapshots);
  db.prepare(
    `INSERT INTO step_runs (id, run_id, node_id, attempt, status, output_preview)
     VALUES ('s1', 'r-done', 'a', 1, 'Succeeded', '{"ok":true}')`,
  ).run();
  db.prepare(
    `INSERT INTO jobs (id, run_id, status, available_at, created_at, updated_at)
     VALUES ('j1', 'r-queued', 'queued', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO artifacts (id, run_id, step_run_id, path, content_type, size_bytes, sha256, created_at)
     VALUES ('art1', 'r-done', 's1', 'r-done/s1/art1', 'text/plain', 5, ?, '2026-01-01T00:00:00.000Z')`,
  ).run('a'.repeat(64));
  db.prepare(
    "INSERT INTO run_events (run_id, type, at, payload) VALUES ('r-done', 'run.status', '2026-01-01T00:00:00.000Z', '{}')",
  ).run();
  return db;
};

describe('migration 002 (Phase 2)', () => {
  it('upgrades a populated Phase 1 database without losing or altering any row', async () => {
    const db = await openPhase1Database();
    const before = {
      runs: all(db, 'SELECT * FROM runs ORDER BY id'),
      steps: all(db, 'SELECT * FROM step_runs ORDER BY id'),
      jobs: all(db, 'SELECT * FROM jobs ORDER BY id'),
      artifacts: all(db, 'SELECT * FROM artifacts ORDER BY id'),
      events: all(db, 'SELECT * FROM run_events ORDER BY seq'),
    };

    // Migration 003 (Service Bus Inspector) follows 002 and touches none of its tables.
    expect(migrate(db)).toEqual({ applied: [2, 3, 4, 5, 6], currentVersion: 6 });

    // Existing columns are byte-for-byte unchanged (snapshots included); new columns are defaults.
    const after = all(db, 'SELECT * FROM runs ORDER BY id');
    expect(after).toHaveLength(before.runs.length);
    after.forEach((row, index) => {
      const { continuation_generation, paused_at, run_number, ...rest } = row;
      expect(run_number === null || typeof run_number === 'number').toBe(true);
      expect(continuation_generation).toBe(0);
      expect(paused_at).toBeNull();
      expect(rest).toEqual(before.runs[index]);
    });
    expect(all(db, 'SELECT * FROM step_runs ORDER BY id')).toEqual(before.steps);
    // Dropping the old parent tables must not have cascaded into children.
    expect(all(db, 'SELECT * FROM jobs ORDER BY id')).toEqual(before.jobs);
    expect(all(db, 'SELECT * FROM artifacts ORDER BY id')).toEqual(before.artifacts);
    expect(all(db, 'SELECT * FROM run_events ORDER BY seq')).toEqual(before.events);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(pragma(db, 'foreign_keys')).toBe(1);
  });

  it('keeps the Phase 1 indexes and foreign-key behaviour', async () => {
    const db = await openPhase1Database();
    migrate(db);
    const indexes = all(db, "SELECT name FROM sqlite_master WHERE type = 'index'").map(
      (row) => row.name,
    );
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_runs_status',
        'idx_runs_requested_at',
        'idx_runs_test',
        'idx_runs_parent',
        'idx_step_runs_run',
        'idx_jobs_claim',
        'uq_run_pauses_active',
      ]),
    );
    // Deleting a Run still cascades to its Step Runs, jobs and artifacts.
    // The child's parent_run_id reference is still enforced (no cascade in Phase 1 either).
    expect(() => db.prepare("DELETE FROM runs WHERE id = 'r-done'").run()).toThrow();
    db.prepare("DELETE FROM runs WHERE id = 'r-child'").run();
    db.prepare("DELETE FROM runs WHERE id = 'r-done'").run();
    expect(all(db, "SELECT id FROM step_runs WHERE run_id = 'r-done'")).toEqual([]);
    expect(all(db, 'SELECT id FROM artifacts')).toEqual([]);
  });

  it('accepts Paused for Runs and Step Runs and still rejects unknown statuses', async () => {
    const db = await openPhase1Database();
    migrate(db);
    db.prepare("UPDATE runs SET status = 'Paused' WHERE id = 'r-running'").run();
    db.prepare("UPDATE step_runs SET status = 'Paused' WHERE id = 's1'").run();
    expect(() =>
      db.prepare("UPDATE runs SET status = 'Sleeping' WHERE id = 'r-queued'").run(),
    ).toThrow();
    expect(() =>
      db.prepare("UPDATE step_runs SET status = 'Sleeping' WHERE id = 's1'").run(),
    ).toThrow();
    expect(() =>
      db.prepare("UPDATE runs SET continuation_generation = -1 WHERE id = 'r-queued'").run(),
    ).toThrow();
  });

  it('enforces one active pause per Run and a unique generation', async () => {
    const db = await openPhase1Database();
    migrate(db);
    const insert = (id: string, generation: number, resolved = false): void => {
      db.prepare(
        `INSERT INTO run_pauses (id, run_id, breakpoint_step_run_id, breakpoint_node_id, paused_at,
           continuation_generation, resumed_at)
         VALUES (?, 'r-done', 's1', 'a', '2026-01-01T00:00:00.000Z', ?, ?)`,
      ).run(id, generation, resolved ? '2026-01-01T00:00:01.000Z' : null);
    };
    insert('p1', 0);
    expect(() => insert('p2', 1)).toThrow(); // second active pause for the same Run
    db.prepare(
      "UPDATE run_pauses SET resumed_at = '2026-01-01T00:00:01.000Z' WHERE id = 'p1'",
    ).run();
    insert('p2', 1); // allowed once the first is resolved
    expect(() => insert('p3', 1, true)).toThrow(); // generation already used
    expect(() =>
      db
        .prepare("UPDATE run_pauses SET resumed_at = 'x', cancelled_at = 'y' WHERE id = 'p2'")
        .run(),
    ).toThrow(); // cannot be both resumed and cancelled
    // The child's parent_run_id reference is still enforced (no cascade in Phase 1 either).
    expect(() => db.prepare("DELETE FROM runs WHERE id = 'r-done'").run()).toThrow();
    db.prepare("DELETE FROM runs WHERE id = 'r-child'").run();
    db.prepare("DELETE FROM runs WHERE id = 'r-done'").run();
    expect(all(db, 'SELECT id FROM run_pauses')).toEqual([]); // cascades with the Run
  });

  it('creates Suite Run tables that constrain positions, links and statuses', async () => {
    const db = await openPhase1Database();
    migrate(db);
    db.prepare(
      `INSERT INTO suite_runs (id, status, environment_id, suite_id, suite_version, requested_by, requested_at,
         max_concurrency, snapshots)
       VALUES ('sr1', 'Queued', 'local-example', 'suite-1', 1, 'tester', '2026-01-01T00:00:00.000Z', 2, '{}')`,
    ).run();
    const item = (id: string, position: number, runId: string | null, status = 'Pending'): void => {
      db.prepare(
        `INSERT INTO suite_run_items (id, suite_run_id, position, test_id, test_version, data_set_id,
           data_set_version, run_id, status)
         VALUES (?, 'sr1', ?, 't', 1, 'd', 1, ?, ?)`,
      ).run(id, position, runId, status);
    };
    item('i0', 0, null);
    item('i1', 1, null); // several undispatched items may share a NULL run
    expect(() => item('dup', 1, null)).toThrow(); // position unique within a Suite Run
    item('i2', 2, 'r-queued');
    expect(() => item('i3', 3, 'r-queued')).toThrow(); // a child Run belongs to one item
    expect(() => item('i4', 4, null, 'Sleeping')).toThrow();
    expect(() => item('i5', 5, 'missing-run')).toThrow(); // child Run must exist
    expect(() =>
      db.prepare("UPDATE suite_runs SET max_concurrency = 0 WHERE id = 'sr1'").run(),
    ).toThrow();
    db.prepare("DELETE FROM suite_runs WHERE id = 'sr1'").run();
    expect(all(db, 'SELECT id FROM suite_run_items')).toEqual([]);
  });

  it('rolls back a failing table-rebuild migration and restores foreign keys', async () => {
    const dir = await makeTempDir();
    const migrationsDir = join(dir, 'migrations');
    await mkdir(migrationsDir);
    await writeFile(join(migrationsDir, '001_a.sql'), 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    await writeFile(
      join(migrationsDir, '002_b.sql'),
      [
        '-- migrate:foreign-keys-off',
        'CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a (id));',
        'INSERT INTO b (id, a_id) VALUES (1, 999);', // dangling reference
      ].join('\n'),
    );
    const db = openDatabase({ path: join(dir, 'db.sqlite') });
    onCleanup(() => db.close());

    expect(() => migrate(db, loadMigrations(migrationsDir))).toThrow('foreign key violation');
    expect(pragma(db, 'foreign_keys')).toBe(1);
    expect(all(db, "SELECT name FROM sqlite_master WHERE name = 'b'").length).toBe(0);
    expect(
      (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v,
    ).toBe(1);
  });
});
