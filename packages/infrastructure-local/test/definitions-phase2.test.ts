import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TestDefinition } from '@test-platform/contracts';
import type { SaveAssetInput } from '@test-platform/core';
import {
  LocalDefinitionRepository,
  SqliteAssetIndex,
  migrate,
  openDatabase,
} from '../src/index.js';
import { FakeClock, cleanupAll, makeTempDir, onCleanup } from './helpers.js';

afterEach(cleanupAll);

const TEST_ID = '01JTEST8M2B5D4KQ7XNH3WV9ZA';
const DATA_ID = '01JDATA0N5C6E7MR8YPJ4XW1BC';
const SB_CONNECTION =
  'Endpoint=sb://example.servicebus.windows.net/;SharedAccessKeyName=send;SharedAccessKey=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==';

const node = (id: string, y: number, x = 0, type = 'delay') => ({
  id,
  type,
  name: id,
  parameters: type === 'delay' ? { durationSeconds: 1 } : {},
  position: { x, y },
});

const testInput = (overrides: Record<string, unknown> = {}): SaveAssetInput<'test'> =>
  ({
    schemaVersion: 2,
    id: TEST_ID,
    name: 'Position sequenced',
    tags: [],
    variables: {},
    editor: { layoutDirection: 'vertical', autoSequenceFromPosition: true },
    nodes: [node('a', 0), node('b', 100), node('c', 200)],
    edges: [],
    ...overrides,
  }) as SaveAssetInput<'test'>;

const setup = async () => {
  const dir = await makeTempDir();
  const db = openDatabase({ path: join(dir, 'runtime', 'platform.db') });
  onCleanup(() => db.close());
  migrate(db);
  const repo = new LocalDefinitionRepository({
    definitionsDir: join(dir, 'definitions'),
    index: new SqliteAssetIndex(db),
    clock: new FakeClock(),
  });
  await repo.ensureDirectories();
  return { dir, repo };
};

const pairs = (test: TestDefinition): string[] => test.edges.map((e) => `${e.from}>${e.to}`);

describe('normalized flow layout persistence', () => {
  it('persists server-generated, system-managed edges for position-managed Tests', async () => {
    const { repo } = await setup();
    // The client sends no edges (or wrong ones); the stored Test has the derived sequence.
    const saved = await repo.save('test', testInput({ edges: [{ from: 'c', to: 'a' }] }), {
      actor: 'ann',
    });
    expect(pairs(saved.asset)).toEqual(['a>b', 'b>c']);
    expect(saved.asset.edges.every((e) => e.metadata?.systemManaged === true)).toBe(true);
    expect((await repo.get('test', TEST_ID))?.asset.edges).toEqual(saved.asset.edges);
  });

  it('re-sequences when a node is moved above another, keeping versions immutable', async () => {
    const { repo } = await setup();
    const v1 = await repo.save('test', testInput(), { actor: 'ann' });
    const moved = await repo.save(
      'test',
      testInput({ nodes: [node('a', 0), node('b', 100), node('c', -50)] }),
      { actor: 'ann', expectedVersion: 1 },
    );
    expect(pairs(v1.asset)).toEqual(['a>b', 'b>c']);
    expect(pairs(moved.asset)).toEqual(['c>a', 'a>b']);
    // Version 1 still reads back with its original order.
    expect(pairs((await repo.get('test', TEST_ID, 1))!.asset)).toEqual(['a>b', 'b>c']);
  });

  it('rejects position-managed nodes without numeric positions', async () => {
    const { repo } = await setup();
    const withoutPosition = {
      id: 'a',
      type: 'delay',
      name: 'a',
      parameters: { durationSeconds: 1 },
    };
    await expect(
      repo.save('test', testInput({ nodes: [withoutPosition] }), { actor: 'ann' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FLOW' });
  });

  it('leaves legacy Tests untouched: stored edges stay authoritative', async () => {
    const { repo, dir } = await setup();
    const legacy = {
      schemaVersion: 1,
      nodes: [node('a', 300), node('b', 0)].map((n) => ({ ...n, position: undefined })),
      edges: [{ from: 'a', to: 'b' }],
      editor: undefined,
    };
    const saved = await repo.save('test', testInput(legacy), { actor: 'ann' });
    expect(saved.asset.edges).toEqual([{ from: 'a', to: 'b' }]);
    const [file] = (await readdir(join(dir, 'definitions', 'tests'))).filter((n) =>
      n.endsWith('.json'),
    );
    const stored = JSON.parse(await readFile(join(dir, 'definitions', 'tests', file!), 'utf8'));
    expect(stored.edges).toEqual([{ from: 'a', to: 'b' }]);
    expect('editor' in stored).toBe(false);
  });

  it('preserves hand-authored order when editor sequencing is explicitly disabled', async () => {
    const { repo } = await setup();
    const saved = await repo.save(
      'test',
      testInput({
        editor: { layoutDirection: 'vertical', autoSequenceFromPosition: false },
        nodes: [node('a', 300), node('b', 0)],
        edges: [{ from: 'a', to: 'b' }],
      }),
      { actor: 'ann' },
    );
    expect(pairs(saved.asset)).toEqual(['a>b']);
  });
});

describe('inline secret protection', () => {
  it('refuses a Test whose parameters contain a connection-string-shaped value', async () => {
    const { repo } = await setup();
    const error = await repo
      .save(
        'test',
        testInput({
          nodes: [{ ...node('a', 0), parameters: { body: `x ${SB_CONNECTION}` } }],
        }),
        { actor: 'ann' },
      )
      .catch((e: unknown) => e as { code: string; message: string; issues: { path: string }[] });
    expect(error).toMatchObject({ code: 'VALIDATION_INLINE_SECRET' });
    expect((error as { issues: { path: string }[] }).issues[0]?.path).toBe(
      '/nodes/0/parameters/body',
    );
    expect(JSON.stringify(error)).not.toContain('Zm9vYmFy');
  });

  it('refuses secret-carrying parameter names unless they are expressions', async () => {
    const { repo } = await setup();
    await expect(
      repo.save(
        'test',
        testInput({ nodes: [{ ...node('a', 0), parameters: { inlineSecret: 'hunter2hunter2' } }] }),
        { actor: 'ann' },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_INLINE_SECRET' });
    await expect(
      repo.save(
        'test',
        testInput({
          nodes: [{ ...node('a', 0), parameters: { connectionString: '{{environment.value}}' } }],
        }),
        { actor: 'ann' },
      ),
    ).resolves.toBeDefined();
  });

  it('refuses Test Data that embeds a credential', async () => {
    const { repo } = await setup();
    await expect(
      repo.save(
        'test-data',
        {
          schemaVersion: 1,
          id: DATA_ID,
          name: 'Data',
          tags: [],
          data: { order: { id: 1 }, note: SB_CONNECTION },
        } as SaveAssetInput<'test-data'>,
        { actor: 'ann' },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_INLINE_SECRET' });
  });

  it('allows ordinary Test Data, including a field named password', async () => {
    const { repo } = await setup();
    const saved = await repo.save(
      'test-data',
      {
        schemaVersion: 1,
        id: DATA_ID,
        name: 'Login data',
        tags: [],
        data: { user: { name: 'ann', password: 'not-a-real-secret' } },
      } as SaveAssetInput<'test-data'>,
      { actor: 'ann' },
    );
    expect(saved.asset.version).toBe(1);
  });
});
