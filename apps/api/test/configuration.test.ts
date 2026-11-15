import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  EnvironmentConfig,
  EnvironmentConfigList,
  EnvironmentSummary,
  SecretsOverview,
} from '@test-platform/contracts';
import { cleanupAll, createTestApp, type TestApp } from './helpers.js';

afterEach(cleanupAll);

// Test-only value, shaped like a real credential.
const VALUE = 'plain-text-secret-0123456789';

const base = (overrides: Partial<EnvironmentConfig> = {}): EnvironmentConfig => ({
  id: 'orders-test',
  name: 'Orders test',
  classification: 'TEST',
  targets: {
    api: {
      kind: 'http',
      baseUrl: 'https://example.azure-api.net',
      allowedPaths: ['/orders/*'],
      authentication: {
        type: 'secretReference',
        provider: 'localPlainText',
        name: 'orders-api-key',
      },
    },
    events: {
      kind: 'azureServiceBus',
      fullyQualifiedNamespace: 'example.servicebus.windows.net',
      allowedEntities: ['order-events'],
      allowedOperations: ['send', 'inspect'],
      credential: {
        type: 'secretReference',
        provider: 'keyVault',
        name: 'orders-bus-conn',
        usage: 'connectionString',
      },
    },
  },
  ...overrides,
});

const seeded = { environments: [base()] };

const get = (t: TestApp, url: string) => t.request({ url: `/api/v1${url}` });
const send = (t: TestApp, method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  t.request({ method, url: `/api/v1${url}`, ...(payload ? { payload } : {}) });

const list = async (t: TestApp) =>
  t.json<EnvironmentConfigList>(await get(t, '/environment-configs'));
const fileOf = (t: TestApp) => join(t.dir, 'config', 'environments.local.json');

describe('Environment configuration API', () => {
  it('lists the configured Environments with a revision', async () => {
    const t = await createTestApp({ environments: seeded });
    const result = await list(t);
    expect(result.items.map((e) => e.id)).toEqual(['orders-test']);
    expect(result.revision).toMatch(/^[0-9a-f]{16}$/);
  });

  it('creates an Environment, writes the file, and the picker sees it at once', async () => {
    const t = await createTestApp({ environments: seeded });
    const { revision } = await list(t);
    const created = await send(t, 'POST', '/environment-configs', {
      environment: base({ id: 'orders-dev', name: 'Orders dev', classification: 'LOCAL' }),
      revision,
    });
    expect(created.statusCode).toBe(201);
    const result = t.json<EnvironmentConfigList>(created);
    expect(result.items.map((e) => e.id)).toEqual(['orders-test', 'orders-dev']);
    expect(result.revision).not.toBe(revision);

    const onDisk = JSON.parse(await readFile(fileOf(t), 'utf8')) as {
      environments: { id: string }[];
    };
    expect(onDisk.environments.map((e) => e.id)).toEqual(['orders-test', 'orders-dev']);
    const summaries = t.json<{ items: EnvironmentSummary[] }>(await get(t, '/environments')).items;
    expect(summaries.map((s) => s.id)).toEqual(['orders-test', 'orders-dev']);
  });

  it('works when no Environment file exists yet', async () => {
    const t = await createTestApp({ environments: null });
    const empty = await list(t);
    expect(empty.items).toEqual([]);
    const created = await send(t, 'POST', '/environment-configs', {
      environment: base(),
      revision: empty.revision,
    });
    expect(created.statusCode).toBe(201);
    expect((await list(t)).items).toHaveLength(1);
  });

  it('updates and deletes, each against the latest revision', async () => {
    const t = await createTestApp({ environments: seeded });
    const first = await list(t);
    const updated = await send(t, 'PUT', '/environment-configs/orders-test', {
      environment: base({ name: 'Renamed', limits: { maxSuiteConcurrency: 3 } }),
      revision: first.revision,
    });
    expect(updated.statusCode).toBe(200);
    const after = t.json<EnvironmentConfigList>(updated);
    expect(after.items[0]).toMatchObject({ name: 'Renamed', limits: { maxSuiteConcurrency: 3 } });

    const removed = await send(
      t,
      'DELETE',
      `/environment-configs/orders-test?revision=${after.revision}`,
    );
    expect(removed.statusCode).toBe(200);
    expect(t.json<EnvironmentConfigList>(removed).items).toEqual([]);
    expect(
      (
        await send(
          t,
          'DELETE',
          `/environment-configs/orders-test?revision=${t.json<EnvironmentConfigList>(removed).revision}`,
        )
      ).statusCode,
    ).toBe(404);
  });

  it('refuses a change based on an out-of-date revision (hand edit or another tab)', async () => {
    const t = await createTestApp({ environments: seeded });
    const stale = (await list(t)).revision;
    await send(t, 'PUT', '/environment-configs/orders-test', {
      environment: base({ name: 'First' }),
      revision: stale,
    });
    const lost = await send(t, 'PUT', '/environment-configs/orders-test', {
      environment: base({ name: 'Second' }),
      revision: stale,
    });
    expect(lost.statusCode).toBe(409);
    expect((await list(t)).items[0]!.name).toBe('First');
    expect(
      (
        await send(t, 'POST', '/environment-configs', {
          environment: base({ id: 'x' }),
          revision: stale,
        })
      ).statusCode,
    ).toBe(409);
  });

  it('rejects duplicates, id changes and unknown Environments', async () => {
    const t = await createTestApp({ environments: seeded });
    const { revision } = await list(t);
    expect(
      (await send(t, 'POST', '/environment-configs', { environment: base(), revision })).statusCode,
    ).toBe(409);
    expect(
      (
        await send(t, 'PUT', '/environment-configs/orders-test', {
          environment: base({ id: 'other' }),
          revision,
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await send(t, 'PUT', '/environment-configs/nope', {
          environment: base({ id: 'nope' }),
          revision,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('validates like the file loader: schema, safe targets, and field paths in the problem', async () => {
    const t = await createTestApp({ environments: seeded });
    const { revision } = await list(t);
    const bad = base({
      targets: {
        api: { kind: 'http', baseUrl: 'http://api.example.com', allowedPaths: ['/x'] },
        storage: {
          kind: 'azureBlob',
          accountUrl: 'https://x.blob.core.windows.net/?sig=abc',
          allowedContainers: ['Bad_Name'],
        },
      },
    });
    const response = await send(t, 'POST', '/environment-configs', {
      environment: { ...bad, id: 'bad-one' },
      revision,
    });
    expect(response.statusCode).toBe(422);
    const problem = response.json() as { code: string; errors: { path: string }[] };
    expect(problem.code).toBe('VALIDATION_SCHEMA');
    expect(problem.errors.map((e) => e.path)).toEqual(
      expect.arrayContaining([
        '/targets/api/baseUrl',
        '/targets/storage/accountUrl',
        '/targets/storage/allowedContainers/0',
      ]),
    );

    const schemaBad = await send(t, 'POST', '/environment-configs', {
      environment: { id: 'x', name: 'x' },
      revision,
    });
    expect(schemaBad.statusCode).toBe(422);
    expect((await list(t)).items).toHaveLength(1);
  });

  it('requires Key Vault references for STAGING and PRODUCTION, and allows plain text for LOCAL and TEST', async () => {
    const t = await createTestApp({ environments: seeded });
    const { revision } = await list(t);
    for (const classification of ['STAGING', 'PRODUCTION'] as const) {
      const response = await send(t, 'POST', '/environment-configs', {
        environment: base({ id: `env-${classification.toLowerCase()}`, classification }),
        revision,
      });
      expect(response.statusCode).toBe(422);
      expect((response.json() as { errors: { path: string }[] }).errors.map((e) => e.path)).toEqual(
        ['/targets/api/authentication/provider'],
      );
    }
    const keyVaultOnly = base({ id: 'orders-prod', classification: 'PRODUCTION' });
    (keyVaultOnly.targets.api as { authentication: unknown }).authentication = {
      type: 'secretReference',
      provider: 'keyVault',
      name: 'orders-api-key',
    };
    expect(
      (await send(t, 'POST', '/environment-configs', { environment: keyVaultOnly, revision }))
        .statusCode,
    ).toBe(201);
  });

  it('reports a damaged Environment file instead of overwriting it', async () => {
    const t = await createTestApp({ environments: seeded });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(fileOf(t), '{ nope');
    expect((await get(t, '/environment-configs')).statusCode).toBe(503);
    expect(
      (
        await send(t, 'POST', '/environment-configs', {
          environment: base({ id: 'x' }),
          revision: 'empty',
        })
      ).statusCode,
    ).toBe(503);
    expect(await readFile(fileOf(t), 'utf8')).toBe('{ nope');
  });

  it('writes audit entries without any configuration content', async () => {
    const t = await createTestApp({ environments: seeded });
    const { revision } = await list(t);
    await send(t, 'POST', '/environment-configs', {
      environment: base({ id: 'orders-dev' }),
      revision,
    });
    const rows = t.container.infra.db
      .prepare(
        "SELECT action, entity_id, metadata FROM audit_events WHERE entity_type = 'environment'",
      )
      .all();
    expect(rows).toEqual([
      { action: 'environment.create', entity_id: 'orders-dev', metadata: '{}' },
    ]);
  });
});

describe('Secrets API', () => {
  const overview = async (t: TestApp) => t.json<SecretsOverview>(await get(t, '/secrets'));
  // The test harness itself supplies one environment-variable secret (API_KEY); look entries up by name.
  const named = (result: SecretsOverview, name: string) =>
    result.local.find((entry) => entry.name === name);

  it('lists referenced secrets: missing local ones, and Key Vault references by status only', async () => {
    const t = await createTestApp({ environments: seeded });
    const result = await overview(t);
    expect(named(result, 'orders-api-key')).toEqual(
      expect.objectContaining({
        name: 'orders-api-key',
        source: 'missing',
        inFile: false,
        usedBy: [{ environmentId: 'orders-test', target: 'api' }],
      }),
    );
    expect(result.keyVault).toEqual([
      expect.objectContaining({
        name: 'orders-bus-conn',
        status: 'unconfigured',
        usage: 'connectionString',
      }),
    ]);
    expect(result).toMatchObject({
      keyVaultConfigured: false,
      secretsFile: 'runtime/secrets.local.json',
      environmentsAvailable: true,
    });
  });

  it('sets a secret write-only: stored, usable at once, never returned, never logged', async () => {
    const lines: string[] = [];
    const stream = new Writable({ write: (chunk, _e, cb) => (lines.push(String(chunk)), cb()) });
    const t = await createTestApp({
      environments: seeded,
      logStream: stream,
      env: { TEST_PLATFORM_LOG_LEVEL: 'info' },
    });

    const put = await send(t, 'PUT', '/secrets/local/orders-api-key', { value: VALUE });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain(VALUE);
    expect(put.json()).toEqual({ shadowedByEnvironment: false });

    const result = await get(t, '/secrets');
    expect(result.body).not.toContain(VALUE);
    expect(named(t.json<SecretsOverview>(result), 'orders-api-key')).toMatchObject({
      name: 'orders-api-key',
      source: 'file',
      inFile: true,
    });

    const file = join(t.dir, 'runtime', 'secrets.local.json');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ 'orders-api-key': VALUE });
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o077).toBe(0);

    // The provider the Steps use sees it without a restart, and the redactor masks it.
    const reference = {
      type: 'secretReference',
      provider: 'localPlainText',
      name: 'orders-api-key',
    } as const;
    expect(await t.container.infra.secrets.resolve(reference)).toBe(VALUE);
    expect(t.container.redactor.redactText(`token ${VALUE}`)).not.toContain(VALUE);

    const everything = [
      lines.join(''),
      JSON.stringify(t.container.infra.db.prepare('SELECT * FROM audit_events').all()),
    ].join('\n');
    expect(everything).not.toContain(VALUE);
    expect(everything).toContain('secret.set');
  });

  it('replaces, removes, and reports an environment variable that overrides the file', async () => {
    const t = await createTestApp({
      environments: seeded,
      env: { TEST_PLATFORM_SECRET_ORDERS_API_KEY: 'from-environment-123' },
    });
    expect(
      t.json<{ shadowedByEnvironment: boolean }>(
        await send(t, 'PUT', '/secrets/local/orders-api-key', { value: VALUE }),
      ),
    ).toEqual({
      shadowedByEnvironment: true,
    });
    expect(named(await overview(t), 'orders-api-key')).toMatchObject({
      source: 'environment',
      inFile: true,
      shadowedByEnvironment: true,
    });
    expect((await send(t, 'DELETE', '/secrets/local/orders-api-key')).statusCode).toBe(204);
    expect((await send(t, 'DELETE', '/secrets/local/orders-api-key')).statusCode).toBe(404);
    expect(named(await overview(t), 'orders-api-key')).toMatchObject({
      source: 'environment',
      inFile: false,
    });
  });

  it('validates names and values without echoing them', async () => {
    const t = await createTestApp({ environments: seeded });
    expect((await send(t, 'PUT', '/secrets/local/1bad', { value: VALUE })).statusCode).toBe(400);
    expect((await send(t, 'PUT', '/secrets/local/ok', { value: '' })).statusCode).toBe(400);
    const tooBig = await send(t, 'PUT', '/secrets/local/ok', { value: 'x'.repeat(20_000) });
    expect(tooBig.statusCode).toBe(400);
    const withNull = await send(t, 'PUT', '/secrets/local/ok', { value: `a\u0000${VALUE}` });
    expect(withNull.statusCode).toBe(422);
    expect(withNull.body).not.toContain(VALUE);
    expect((await send(t, 'PUT', '/secrets/local/ok', { value: VALUE, extra: 1 })).statusCode).toBe(
      400,
    );
  });

  it('shows the readiness of Key Vault references once a vault is configured', async () => {
    const t = await createTestApp({
      environments: seeded,
      env: { TEST_PLATFORM_KEY_VAULT_URL: 'https://orders-kv.vault.azure.net' },
    });
    const result = await overview(t);
    expect(result.keyVaultConfigured).toBe(true);
    expect(result.keyVault[0]).toMatchObject({ status: 'configured' });
  });

  it('still lists secrets when the Environment file is unavailable', async () => {
    const t = await createTestApp({ environments: null });
    await send(t, 'PUT', '/secrets/local/standalone', { value: VALUE });
    const result = await overview(t);
    expect(result.environmentsAvailable).toBe(false);
    expect(named(result, 'standalone')).toEqual(
      expect.objectContaining({ name: 'standalone', source: 'file', usedBy: [] }),
    );
  });
});
