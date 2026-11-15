import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SaveAssetInput } from '@test-platform/core';
import {
  LocalDefinitionRepository,
  SqliteAssetIndex,
  hashContent,
  migrate,
  openDatabase,
} from '../src/index.js';
import { FakeClock, cleanupAll, makeTempDir, onCleanup } from './helpers.js';

afterEach(cleanupAll);

const TEST_ID = '01JTEST8M2B5D4KQ7XNH3WV9ZA';

const testInput = (overrides: Record<string, unknown> = {}): SaveAssetInput<'test'> =>
  ({
    schemaVersion: 1,
    id: TEST_ID,
    name: 'Order processing happy path',
    tags: ['orders'],
    variables: {},
    nodes: [{ id: 'wait', type: 'delay', name: 'Wait', parameters: { durationSeconds: 1 } }],
    edges: [],
    ...overrides,
  }) as SaveAssetInput<'test'>;

const setup = async () => {
  const dir = await makeTempDir();
  const definitionsDir = join(dir, 'definitions');
  const dbPath = join(dir, 'runtime', 'platform.db');
  const clock = new FakeClock();
  const open = () => {
    const db = openDatabase({ path: dbPath });
    onCleanup(() => {
      try {
        db.close();
      } catch {
        // already closed by the test
      }
    });
    migrate(db);
    return { db, index: new SqliteAssetIndex(db) };
  };
  const { db, index } = open();
  const repo = new LocalDefinitionRepository({ definitionsDir, index, clock });
  await repo.ensureDirectories();
  return { dir, definitionsDir, clock, db, index, repo, open };
};

describe('LocalDefinitionRepository.save', () => {
  it('creates version 1 with metadata, a content hash, and a pretty-printed file', async () => {
    const { repo, definitionsDir, db } = await setup();
    const saved = await repo.save('test', testInput(), { actor: 'ann@example.test' });

    expect(saved.asset).toMatchObject({
      version: 1,
      metadata: {
        createdBy: 'ann@example.test',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedBy: 'ann@example.test',
      },
    });
    const file = join(definitionsDir, 'tests', `order-processing-happy-path--${TEST_ID}.json`);
    const text = await readFile(file, 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "schemaVersion": 1');
    expect(saved.contentHash).toBe(hashContent(text));
    expect(JSON.parse(text)).toEqual(saved.asset);
    expect(await readdir(join(definitionsDir, 'tests'))).toEqual(
      [`order-processing-happy-path--${TEST_ID}.json`, '.versions'].sort(),
    );
    db.close();
  });

  it('versions on update, keeps createdAt/createdBy, and keeps the file name stable across renames', async () => {
    const { repo, clock, definitionsDir, db } = await setup();
    await repo.save('test', testInput(), { actor: 'ann' });
    clock.advance(60_000);
    const v2 = await repo.save('test', testInput({ name: 'Renamed' }), {
      actor: 'bob',
      expectedVersion: 1,
    });

    expect(v2.asset.version).toBe(2);
    expect(v2.asset.metadata).toMatchObject({
      createdBy: 'ann',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedBy: 'bob',
      updatedAt: '2026-01-01T00:01:00.000Z',
    });
    expect(
      (await readdir(join(definitionsDir, 'tests'))).filter((n) => n.endsWith('.json')),
    ).toEqual([`order-processing-happy-path--${TEST_ID}.json`]);
    expect((await repo.list('test')).map((s) => [s.name, s.currentVersion])).toEqual([
      ['Renamed', 2],
    ]);
    expect((await repo.listVersions('test', TEST_ID)).map((v) => [v.version, v.createdBy])).toEqual(
      [
        [1, 'ann'],
        [2, 'bob'],
      ],
    );
    db.close();
  });

  it('rejects stale and missing expected versions with VALIDATION_CONFLICT', async () => {
    const { repo, db } = await setup();
    await expect(
      repo.save('test', testInput(), { actor: 'a', expectedVersion: 3 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_CONFLICT' });
    await repo.save('test', testInput(), { actor: 'a' });
    await expect(repo.save('test', testInput(), { actor: 'a' })).rejects.toMatchObject({
      code: 'VALIDATION_CONFLICT',
    });
    await repo.save('test', testInput(), { actor: 'a', expectedVersion: 1 });
    await expect(
      repo.save('test', testInput(), { actor: 'a', expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_CONFLICT' });
    db.close();
  });

  it('keeps every saved version immutable and retrievable', async () => {
    const { repo, definitionsDir, db } = await setup();
    const v1 = await repo.save('test', testInput({ description: 'first' }), { actor: 'a' });
    await repo.save('test', testInput({ description: 'second' }), {
      actor: 'a',
      expectedVersion: 1,
    });

    expect((await repo.get('test', TEST_ID, 1))?.asset).toEqual(v1.asset);
    expect((await repo.get('test', TEST_ID))?.asset).toMatchObject({
      version: 2,
      description: 'second',
    });
    expect(await repo.get('test', TEST_ID, 9)).toBeUndefined();
    const history = join(definitionsDir, 'tests', '.versions', TEST_ID);
    expect((await readdir(history)).sort()).toEqual(['v1.json', 'v2.json']);
    db.close();
  });

  it('refuses to overwrite an existing version file (concurrent save)', async () => {
    const { repo, definitionsDir, db } = await setup();
    await repo.save('test', testInput(), { actor: 'a' });
    // Simulate another process that already wrote version 2.
    await writeFile(join(definitionsDir, 'tests', '.versions', TEST_ID, 'v2.json'), '{}');
    await expect(
      repo.save('test', testInput(), { actor: 'a', expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_CONFLICT' });
    expect((await repo.get('test', TEST_ID))?.asset.version).toBe(1);
    db.close();
  });

  it('rejects schema-invalid assets and writes nothing', async () => {
    const { repo, definitionsDir, db } = await setup();
    await expect(repo.save('test', testInput({ nodes: [] }), { actor: 'a' })).rejects.toMatchObject(
      {
        code: 'VALIDATION_SCHEMA',
        issues: [expect.objectContaining({ path: '/nodes' })],
      },
    );
    await expect(
      repo.save('test', testInput({ id: '../../evil' }), { actor: 'a' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_REFERENCE' });
    expect((await readdir(join(definitionsDir, 'tests'))).filter((n) => n !== '.versions')).toEqual(
      [],
    );
    expect(await repo.list('test')).toEqual([]);
    db.close();
  });

  it('lists and filters, and deletes files, history, and index entries', async () => {
    const { repo, definitionsDir, db } = await setup();
    await repo.save('test', testInput(), { actor: 'a' });
    await repo.save(
      'test',
      testInput({ id: '01JTEST8M2B5D4KQ7XNH3WV9ZB', name: 'Other', tags: ['x'] }),
      { actor: 'a' },
    );

    expect((await repo.list('test', { tag: 'x' })).map((s) => s.name)).toEqual(['Other']);
    expect((await repo.list('test', { search: 'ORDER' })).map((s) => s.name)).toEqual([
      'Order processing happy path',
    ]);

    expect(await repo.delete('test', TEST_ID)).toBe(true);
    expect(await repo.delete('test', TEST_ID)).toBe(false);
    expect(await repo.get('test', TEST_ID)).toBeUndefined();
    expect((await readdir(join(definitionsDir, 'tests', '.versions'))).includes(TEST_ID)).toBe(
      false,
    );
    expect((await repo.list('test')).map((s) => s.name)).toEqual(['Other']);
    db.close();
  });

  it('stores test data and suites in their own folders', async () => {
    const { repo, definitionsDir, db } = await setup();
    await repo.save(
      'test-data',
      {
        schemaVersion: 1,
        id: '01JDATA0N5C6E7MR8YPJ4XW1BC',
        name: 'Data',
        tags: [],
        data: { a: 1 },
      } as SaveAssetInput<'test-data'>,
      { actor: 'a' },
    );
    await repo.save(
      'suite',
      {
        schemaVersion: 1,
        id: '01JSWEET9P6D7F8NS0ZQK5YX2D',
        name: 'Suite',
        tags: [],
        items: [{ testId: TEST_ID, dataSetId: '01JDATA0N5C6E7MR8YPJ4XW1BC' }],
      } as SaveAssetInput<'suite'>,
      { actor: 'a' },
    );
    expect(
      (await readdir(join(definitionsDir, 'test-data'))).some((n) => n.startsWith('data--')),
    ).toBe(true);
    expect(
      (await readdir(join(definitionsDir, 'suites'))).some((n) => n.startsWith('suite--')),
    ).toBe(true);
    db.close();
  });
});

describe('LocalDefinitionRepository.reconcile', () => {
  it('rebuilds the index from files after the database is lost', async () => {
    const { repo, db, definitionsDir, dir, clock } = await setup();
    await repo.save('test', testInput(), { actor: 'ann' });
    await repo.save('test', testInput(), { actor: 'bob', expectedVersion: 1 });
    db.close();
    await rm(join(dir, 'runtime'), { recursive: true, force: true });

    const fresh = openDatabase({ path: join(dir, 'runtime', 'platform.db') });
    onCleanup(() => {
      try {
        fresh.close();
      } catch {
        // already closed by the test
      }
    });
    migrate(fresh);
    const rebuilt = new LocalDefinitionRepository({
      definitionsDir,
      index: new SqliteAssetIndex(fresh),
      clock,
    });
    const report = await rebuilt.reconcile();

    expect(report.added).toHaveLength(1);
    expect(report.invalid).toEqual([]);
    expect((await rebuilt.list('test')).map((s) => [s.id, s.currentVersion])).toEqual([
      [TEST_ID, 2],
    ]);
    expect((await rebuilt.listVersions('test', TEST_ID)).map((v) => v.version)).toEqual([1, 2]);
    expect((await rebuilt.reconcile()).unchanged).toBe(1);
    fresh.close();
  });

  it('detects added, modified, and removed files and reports invalid ones without indexing them', async () => {
    const { repo, db, definitionsDir } = await setup();
    const saved = await repo.save('test', testInput(), { actor: 'a' });
    const tests = join(definitionsDir, 'tests');
    const file = join(tests, `order-processing-happy-path--${TEST_ID}.json`);

    const edited = { ...saved.asset, version: 2, name: 'Edited by hand' };
    await writeFile(file, `${JSON.stringify(edited, null, 2)}\n`);
    await writeFile(join(tests, 'broken--01JTEST8M2B5D4KQ7XNH3WV9ZC.json'), '{ not json');
    await writeFile(
      join(tests, 'wrong-name--01JTEST8M2B5D4KQ7XNH3WV9ZD.json'),
      JSON.stringify({ ...saved.asset, id: '01JTEST8M2B5D4KQ7XNH3WV9ZE' }),
    );
    await writeFile(
      join(tests, 'invalid--01JTEST8M2B5D4KQ7XNH3WV9ZF.json'),
      JSON.stringify({ ...saved.asset, id: '01JTEST8M2B5D4KQ7XNH3WV9ZF', nodes: [] }),
    );

    const report = await repo.reconcile();
    expect(report.updated).toEqual([`tests/order-processing-happy-path--${TEST_ID}.json`]);
    expect(report.invalid.map((i) => i.path).sort()).toEqual([
      'tests/broken--01JTEST8M2B5D4KQ7XNH3WV9ZC.json',
      'tests/invalid--01JTEST8M2B5D4KQ7XNH3WV9ZF.json',
      'tests/wrong-name--01JTEST8M2B5D4KQ7XNH3WV9ZD.json',
    ]);
    expect((await repo.list('test')).map((s) => [s.name, s.currentVersion])).toEqual([
      ['Edited by hand', 2],
    ]);
    expect((await repo.listVersions('test', TEST_ID)).map((v) => v.version)).toEqual([1, 2]);

    await rm(file);
    const afterRemoval = await repo.reconcile();
    expect(afterRemoval.removed).toEqual([`tests/order-processing-happy-path--${TEST_ID}.json`]);
    expect(await repo.list('test')).toEqual([]);
    db.close();
  });

  it('ignores temporary and hidden files and tolerates a missing directory', async () => {
    const { repo, db, definitionsDir } = await setup();
    await writeFile(join(definitionsDir, 'tests', '.something.json.abc123.tmp'), 'partial');
    await writeFile(join(definitionsDir, 'tests', '.hidden.json'), '{}');
    await rm(join(definitionsDir, 'suites'), { recursive: true });
    const report = await repo.reconcile();
    expect(report).toEqual({ added: [], updated: [], removed: [], unchanged: 0, invalid: [] });
    await mkdir(join(definitionsDir, 'suites'), { recursive: true });
    db.close();
  });
});
