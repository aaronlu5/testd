import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { ConfigError, loadConfig } from '../src/config.js';
import { createHealthServer } from '../src/health.js';
import { cleanupAll, createHarness } from './helpers.js';

afterEach(cleanupAll);

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const config = loadConfig({}, process.cwd());
    expect(config).toMatchObject({
      healthPort: 3001,
      pollIntervalMs: 1_000,
      leaseMs: 30_000,
      leaseRenewIntervalMs: 10_000,
      defaultStepTimeoutSeconds: 300,
      logLevel: 'info',
    });
    expect(config.workerId).toMatch(/^worker-/);
  });

  it('reports every invalid value together', () => {
    try {
      loadConfig({
        TEST_PLATFORM_LOG_LEVEL: 'loud',
        TEST_PLATFORM_WORKER_POLL_MS: 'soon',
        TEST_PLATFORM_WORKER_LEASE_MS: '1000',
        TEST_PLATFORM_WORKER_LEASE_RENEW_MS: '2000',
        TEST_PLATFORM_WORKER_ID: 'bad id!',
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues).toHaveLength(4);
    }
  });
});

describe('health endpoints', () => {
  it('answers liveness always and readiness from local dependencies', async () => {
    const h = await createHarness();
    const server = createHealthServer(h.container);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect(await (await fetch(`${base}/health/live`)).json()).toEqual({ status: 'alive' });

      // The loop has not polled yet.
      const before = await fetch(`${base}/health/ready`);
      expect(before.status).toBe(503);
      expect(await before.json()).toMatchObject({ checks: { database: 'ok', loop: 'failed' } });

      await h.container.loop.runOnce();
      const after = await fetch(`${base}/health/ready`);
      expect(after.status).toBe(200);
      expect(await after.json()).toEqual({
        status: 'ready',
        checks: { database: 'ok', runtime: 'ok', loop: 'ok' },
      });

      expect((await fetch(`${base}/api/v1/runs`)).status).toBe(404);
      expect((await fetch(`${base}/health/live`, { method: 'POST' })).status).toBe(405);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
