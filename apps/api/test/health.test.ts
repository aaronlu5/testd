import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { cleanupAll, createTestApp, SECRET } from './helpers.js';

afterEach(cleanupAll);

describe('configuration', () => {
  const base = {
    TEST_PLATFORM_RUNTIME_DIR: '/tmp/r',
    TEST_PLATFORM_DEFINITIONS_DIR: '/tmp/d',
    TEST_PLATFORM_CONFIG_DIR: '/tmp/c',
  };

  it('applies safe defaults: loopback binding and local-dev auth', () => {
    const config = loadConfig(base, '/tmp');
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 3000,
      authMode: 'local-dev',
      logLevel: 'info',
      bodyLimitBytes: 1_048_576,
    });
    expect(config.allowedOrigins).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
  });

  it('collects every problem into one error', () => {
    try {
      loadConfig(
        {
          ...base,
          TEST_PLATFORM_API_PORT: '99999',
          TEST_PLATFORM_LOG_LEVEL: 'loud',
          TEST_PLATFORM_API_CORS_ORIGINS: '*,http://ok.example/path',
          TEST_PLATFORM_AUTH_MODE: 'entra',
        },
        '/tmp',
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues.join('\n');
      expect(issues).toContain('TEST_PLATFORM_API_PORT');
      expect(issues).toContain('TEST_PLATFORM_LOG_LEVEL');
      expect(issues).toContain('"*"');
      expect(issues).toContain('/path');
      expect(issues).toContain('AUTH_MODE');
    }
  });

  it('refuses network exposure because only local-dev authentication exists', () => {
    expect(() => loadConfig({ ...base, TEST_PLATFORM_API_HOST: '0.0.0.0' }, '/tmp')).toThrow(
      'ALLOW_REMOTE',
    );
    expect(() =>
      loadConfig(
        { ...base, TEST_PLATFORM_API_HOST: '0.0.0.0', TEST_PLATFORM_API_ALLOW_REMOTE: 'true' },
        '/tmp',
      ),
    ).toThrow('not implemented');
    expect(loadConfig({ ...base, TEST_PLATFORM_API_HOST: '::1' }, '/tmp').host).toBe('::1');
  });

  it('rejects environment file names that escape the config directory', () => {
    expect(() =>
      loadConfig({ ...base, TEST_PLATFORM_ENVIRONMENTS_FILE: '../secrets.json' }, '/tmp'),
    ).toThrow('ENVIRONMENTS_FILE');
  });
});

describe('health', () => {
  it('reports live and ready when every local dependency is available', async () => {
    const t = await createTestApp();
    expect((await t.request({ url: '/health/live' })).json()).toEqual({ status: 'alive' });
    const ready = await t.request({ url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: 'ready',
      checks: { database: 'ok', definitions: 'ok', runtime: 'ok', environments: 'ok' },
    });
  });

  it('fails readiness cleanly, without leaking paths, when the environment config is missing', async () => {
    const t = await createTestApp({ environments: null });
    expect((await t.request({ url: '/health/live' })).statusCode).toBe(200);
    const ready = await t.request({ url: '/health/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({
      status: 'unavailable',
      checks: { database: 'ok', environments: 'failed' },
    });
    expect(ready.body).not.toContain(t.dir);
  });

  it('fails readiness when the database is closed under the running app', async () => {
    const t = await createTestApp();
    t.container.close();
    const ready = await t.request({ url: '/health/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ checks: { database: 'failed' } });
  });

  it('serves liveness and a clear 503 problem in degraded mode (no container)', async () => {
    const t = await createTestApp();
    const degraded = await buildApp({ config: t.config, logger: false });
    expect((await degraded.inject({ url: '/health/live' })).statusCode).toBe(200);
    expect((await degraded.inject({ url: '/health/ready' })).statusCode).toBe(503);

    const response = await degraded.inject({ url: '/api/v1/tests' });
    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ code: 'SYSTEM_UNAVAILABLE', status: 503 });
    await degraded.close();
  });

  it('reconciles existing definition files at startup', async () => {
    const t = await createTestApp();
    expect(t.container.startup.reconcile).toEqual({ added: 0, updated: 0, removed: 0, invalid: 0 });
  });
});

describe('catalog', () => {
  it('lists built-in Step types with schemas', async () => {
    const t = await createTestApp();
    const response = await t.request({ url: '/api/v1/step-types' });
    const { items } = t.json<{
      items: { type: string; configSchema: object; capabilities: { external: boolean } }[];
    }>(response);
    expect(items.map((i) => i.type)).toEqual([
      'assert',
      'blob.download',
      'blob.upload',
      'breakpoint',
      'delay',
      'http.request',
      'serviceBus.send',
      'sql.execute',
      'sql.query',
      'transform.json',
      'waitForCondition',
    ]);
    expect(
      items.every(
        (i) => typeof i.configSchema === 'object' && typeof i.capabilities.external === 'boolean',
      ),
    ).toBe(true);
  });

  it('lists environments as non-secret summaries', async () => {
    const t = await createTestApp();
    const response = await t.request({ url: '/api/v1/environments' });
    expect(response.json()).toEqual({
      items: [
        {
          id: 'local-test',
          name: 'Local test environment',
          classification: 'TEST',
          suiteConcurrencyLimit: 1,
          targets: [{ name: 'example-api', kind: 'http' }],
        },
      ],
    });
    expect(response.body).not.toContain('example.invalid');
    expect(response.body).not.toContain(SECRET);
    expect(response.body).not.toContain('api-key');
  });

  it('reports 503 for environments when the config is invalid', async () => {
    const t = await createTestApp({ environments: { environments: [{ id: 'x' }] } });
    const response = await t.request({ url: '/api/v1/environments' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'SYSTEM_UNAVAILABLE' });
  });
});
