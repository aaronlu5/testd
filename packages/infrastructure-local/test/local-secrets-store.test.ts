import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChainedSecretProvider,
  LocalPlainTextSecretProvider,
  LocalSecretsStore,
} from '../src/index.js';
import { cleanupAll, makeTempDir } from './helpers.js';

afterEach(cleanupAll);

// Test-only values.
const VALUE = 'plain-text-secret-0123456789';

const setup = async (env: Record<string, string> = {}) => {
  const dir = await makeTempDir();
  const file = join(dir, 'secrets.local.json');
  const store = new LocalSecretsStore({ file, env });
  return { dir, file, store, env };
};

describe('LocalSecretsStore', () => {
  it('creates the file on first write and never lists values', async () => {
    const { store, file } = await setup();
    expect(await store.describe()).toEqual([]);
    await store.set('orders-api-key', VALUE);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ 'orders-api-key': VALUE });
    expect(await store.describe()).toEqual([
      { name: 'orders-api-key', inFile: true, inEnvironment: false },
    ]);
    expect(JSON.stringify(await store.describe())).not.toContain(VALUE);
  });

  it.skipIf(process.platform === 'win32')(
    'creates the file readable by its owner only',
    async () => {
      const { store, file } = await setup();
      await store.set('a', VALUE);
      expect((await stat(file)).mode & 0o077).toBe(0);
    },
  );

  it('replaces a secret whose name differs only by case or dashes', async () => {
    const { store, file } = await setup();
    await store.set('orders_api_key', 'first-value-123');
    await store.set('Orders-Api-Key', 'second-value-456');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      'Orders-Api-Key': 'second-value-456',
    });
  });

  it('removes a secret and reports whether it existed', async () => {
    const { store, file } = await setup();
    await store.set('a', VALUE);
    await store.set('b', VALUE);
    expect(await store.remove('A')).toBe(true);
    expect(await store.remove('a')).toBe(false);
    expect(Object.keys(JSON.parse(await readFile(file, 'utf8')))).toEqual(['b']);
  });

  it('shows environment-variable secrets (which win) without exposing them', async () => {
    const { store } = await setup({
      TEST_PLATFORM_SECRET_ORDERS_API_KEY: 'from-environment-123',
      TEST_PLATFORM_SECRET_ONLY_ENV: 'x'.repeat(10),
    });
    await store.set('orders-api-key', VALUE);
    const entries = await store.describe();
    expect(entries).toEqual([
      { name: 'ONLY_ENV', inFile: false, inEnvironment: true },
      { name: 'orders-api-key', inFile: true, inEnvironment: true },
    ]);
    expect(JSON.stringify(entries)).not.toContain('from-environment');
  });

  it('rejects bad names and values without echoing the value', async () => {
    const { store } = await setup();
    expect(() => store.set('1bad', VALUE)).toThrow('secret name');
    expect(() => store.set('ok', '')).toThrow('secret value');
    expect(() => store.set('ok', `a\u0000b`)).toThrow('secret value');
    expect(() => store.set('ok', 'x'.repeat(20_000))).toThrow('secret value');
    try {
      store.set('ok', `bad\u0000${VALUE}`);
    } catch (error) {
      expect((error as Error).message).not.toContain(VALUE);
    }
  });

  it('refuses to edit a damaged file instead of overwriting it', async () => {
    const { store, file } = await setup();
    await writeFile(file, '{ not json');
    await expect(store.set('a', VALUE)).rejects.toThrow('JSON object');
    expect(await readFile(file, 'utf8')).toBe('{ not json');
    await writeFile(file, '{"a": 1}');
    await expect(store.describe()).rejects.toThrow('JSON object');
  });

  it("keeps concurrent writers from losing each other's secrets", async () => {
    const { store, file } = await setup();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => store.set(`secret-${i}`, `value-number-${i}`)),
    );
    expect(Object.keys(JSON.parse(await readFile(file, 'utf8')))).toHaveLength(12);
  });
});

describe('local provider picks up edits without a restart', () => {
  const reference = {
    type: 'secretReference',
    provider: 'localPlainText',
    name: 'api-key',
  } as const;

  it('serves a secret written after start-up, then its replacement, then none after removal', async () => {
    const { file, store } = await setup();
    const local = new LocalPlainTextSecretProvider({ env: {}, secretsFile: file });
    const chain = new ChainedSecretProvider([local]);
    await expect(chain.resolve(reference)).rejects.toThrow('not found');

    await store.set('api-key', 'first-value-123');
    expect(await chain.resolve(reference)).toBe('first-value-123');
    expect(chain.sensitiveValues()).toContain('first-value-123');

    await store.set('api-key', 'second-value-456');
    expect(await chain.resolve(reference)).toBe('second-value-456');

    await store.remove('api-key');
    await expect(chain.resolve(reference)).rejects.toThrow('not found');
  });

  it('masks a value in logs as soon as it is stored, even before anything resolves it', async () => {
    const { file, store } = await setup();
    const chain = new ChainedSecretProvider([
      new LocalPlainTextSecretProvider({ env: {}, secretsFile: file }),
    ]);
    expect(chain.sensitiveValues()).toEqual([]);
    await store.set('api-key', VALUE);
    expect(chain.sensitiveValues()).toContain(VALUE);
  });

  it('fails closed when the file becomes unreadable, but still masks the last good values', async () => {
    const { file, store } = await setup();
    await store.set('api-key', VALUE);
    const local = new LocalPlainTextSecretProvider({ env: {}, secretsFile: file });
    const chain = new ChainedSecretProvider([local]);
    expect(await chain.resolve(reference)).toBe(VALUE);

    await writeFile(file, '{ broken');
    await expect(chain.resolve(reference)).rejects.toThrow('not readable');
    expect(chain.sensitiveValues()).toContain(VALUE);

    await writeFile(file, JSON.stringify({ 'api-key': 'recovered-value-1' }));
    expect(await chain.resolve(reference)).toBe('recovered-value-1');
  });

  it('still prefers an environment variable over the file', async () => {
    const { file, store } = await setup();
    await store.set('api-key', VALUE);
    const local = new LocalPlainTextSecretProvider({
      env: { TEST_PLATFORM_SECRET_API_KEY: 'env-wins-0123456789' },
      secretsFile: file,
    });
    expect(await local.getSecret('api-key')).toBe('env-wins-0123456789');
  });
});
