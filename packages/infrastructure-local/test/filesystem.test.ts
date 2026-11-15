import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileArtifactStore, resolveInside, slugify, writeFileAtomic } from '../src/index.js';
import { cleanupAll, makeTempDir, openMigrated, seedRun } from './helpers.js';

afterEach(cleanupAll);

describe('writeFileAtomic', () => {
  it('creates parent directories and writes the exact content', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'a', 'b', 'file.json');
    await writeFileAtomic(path, '{"ok":true}\n');
    expect(await readFile(path, 'utf8')).toBe('{"ok":true}\n');
  });

  it('replaces existing content and leaves no temporary files behind', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'file.json');
    await writeFileAtomic(path, 'old');
    await writeFileAtomic(path, 'new');
    expect(await readFile(path, 'utf8')).toBe('new');
    expect(await readdir(dir)).toEqual(['file.json']);
  });

  it('leaves the previous content intact when the write fails part-way', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'file.json');
    await writeFileAtomic(path, 'original');
    // A non-string/non-buffer payload makes the temporary-file write throw before the rename.
    await expect(writeFileAtomic(path, 123 as unknown as string)).rejects.toBeDefined();
    expect(await readFile(path, 'utf8')).toBe('original');
    expect(await readdir(dir)).toEqual(['file.json']);
  });

  it('replaces large files completely, one version at a time', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'file.txt');
    for (const variant of ['a'.repeat(200_000), 'b'.repeat(300_000), 'c'.repeat(100_000)]) {
      await writeFileAtomic(path, variant);
      expect(await readFile(path, 'utf8')).toBe(variant);
    }
    expect(await readdir(dir)).toEqual(['file.txt']);
  });

  it('exclusive mode refuses to replace an existing file and cleans up its temp file', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'v1.json');
    await writeFileAtomic(path, 'first', { exclusive: true });
    await expect(writeFileAtomic(path, 'second', { exclusive: true })).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(path, 'utf8')).toBe('first');
    expect(await readdir(dir)).toEqual(['v1.json']);
  });

  it('keeps the original file when the write fails', async () => {
    const dir = await makeTempDir();
    const target = join(dir, 'target');
    await mkdir(target); // renaming a file over a directory fails
    await expect(writeFileAtomic(target, 'x')).rejects.toBeDefined();
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('path safety', () => {
  it.each(['..', '../x', 'a/../../x', '/etc/passwd', 'C:\\Windows\\x', 'a/../..'])(
    'rejects %s',
    (segment) => {
      expect(() => resolveInside('/tmp/root', segment)).toThrow('escapes');
    },
  );

  it('accepts nested relative paths and slugifies names', () => {
    expect(resolveInside('/tmp/root', 'a', 'b')).toMatch(/root[\\/]a[\\/]b$/);
    expect(slugify('Order processing: happy path!')).toBe('order-processing-happy-path');
    expect(slugify('../../etc/passwd')).toBe('etc-passwd');
    expect(slugify('日本語')).toBe('untitled');
  });
});

describe('FileArtifactStore', () => {
  const setup = async () => {
    const { db, dir } = await openMigrated();
    await seedRun(db, 'run-1', 'step-1');
    const artifactsDir = join(dir, 'artifacts');
    return {
      db,
      dir,
      artifactsDir,
      store: new FileArtifactStore({ artifactsDir, db, maxBytes: 1024 }),
    };
  };

  it('stores content under generated ids only and reads it back with its checksum', async () => {
    const { store, artifactsDir } = await setup();
    const artifact = await store.write({
      runId: 'run-1',
      stepRunId: 'step-1',
      content: '{"a":1}',
      contentType: 'application/json',
    });

    expect(artifact).toMatchObject({ runId: 'run-1', stepRunId: 'step-1', sizeBytes: 7 });
    expect(artifact.sha256).toBe(createHash('sha256').update('{"a":1}').digest('hex'));
    expect(await readdir(join(artifactsDir, 'run-1', 'step-1'))).toEqual([artifact.id]);

    const read = await store.read(artifact.id);
    expect(Buffer.from(read?.content ?? []).toString('utf8')).toBe('{"a":1}');
    expect(read?.artifact).toEqual(artifact);
  });

  it.each(['../x', 'a/b', '..', 'a\\b', '', '.hidden', 'x'.repeat(65)])(
    'rejects unsafe identifier %j',
    async (bad) => {
      const { store } = await setup();
      await expect(
        store.write({ runId: bad, stepRunId: 'step-1', content: 'x', contentType: 't' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_REFERENCE' });
      await expect(
        store.write({ runId: 'run-1', stepRunId: bad, content: 'x', contentType: 't' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_REFERENCE' });
    },
  );

  it('returns undefined for unknown or malformed artifact ids instead of touching the filesystem', async () => {
    const { store } = await setup();
    expect(await store.read('../../etc/passwd')).toBeUndefined();
    expect(await store.read('does-not-exist')).toBeUndefined();
    expect(await store.get('a/b')).toBeUndefined();
  });

  it('enforces the size cap and does not leave files or rows behind', async () => {
    const { store, db, artifactsDir } = await setup();
    await expect(
      store.write({
        runId: 'run-1',
        stepRunId: 'step-1',
        content: new Uint8Array(2048),
        contentType: 't',
      }),
    ).rejects.toMatchObject({
      code: 'EXECUTION_ARTIFACT',
    });
    expect(
      Number((db.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as { n: number }).n),
    ).toBe(0);
    expect(await readdir(artifactsDir).catch(() => [])).toEqual([]);
  });

  it('ignores a tampered path column and detects modified content', async () => {
    const { store, db, artifactsDir } = await setup();
    const artifact = await store.write({
      runId: 'run-1',
      stepRunId: 'step-1',
      content: 'original',
      contentType: 't',
    });
    db.prepare('UPDATE artifacts SET path = ? WHERE id = ?').run('../../outside', artifact.id);
    expect(Buffer.from((await store.read(artifact.id))?.content ?? []).toString()).toBe('original');

    await writeFile(join(artifactsDir, 'run-1', 'step-1', artifact.id), 'tampered');
    await expect(store.read(artifact.id)).rejects.toMatchObject({ code: 'EXECUTION_ARTIFACT' });
  });

  it('removes the file when the database insert fails (unknown step run)', async () => {
    const { store, artifactsDir } = await setup();
    await expect(
      store.write({ runId: 'run-1', stepRunId: 'missing-step', content: 'x', contentType: 't' }),
    ).rejects.toBeDefined();
    expect(await readdir(join(artifactsDir, 'run-1', 'missing-step'))).toEqual([]);
  });
});
