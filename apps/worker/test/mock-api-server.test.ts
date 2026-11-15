import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { MockSetupAsset } from '@test-platform/contracts';
import { MockApiRegistry } from '@test-platform/core';
import { createMockApiServer } from '../src/mock-api-server.js';

const setup = (rules: MockSetupAsset['rules']): MockSetupAsset => ({
  schemaVersion: 1,
  id: 'setup-1',
  version: 1,
  name: 'Gateway',
  tags: [],
  metadata: { createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'test' },
  rules,
});

const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child() {
    return this;
  },
  entries: () => [],
} as never;

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

const start = async (
  active: (runId: string) => Promise<boolean> = async () => true,
  log?: { record: (entry: never) => unknown },
) => {
  const registry = new MockApiRegistry();
  const server = createMockApiServer({
    registry,
    log: log as never,
    logger: silent,
    isRunActive: active,
    pruneEveryMs: 0,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { registry, base };
};

describe('Mock API server', () => {
  it('answers with the status and JSON body of the matching rule, ignoring the query string', async () => {
    const { registry, base } = await start();
    registry.register('run-1', [
      setup([
        { path: '/payments/[0-9]+', method: 'GET', status: 200, body: { id: 5, paid: true } },
        { path: '/payments', method: 'POST', status: 201 },
      ]),
    ]);
    const found = await fetch(`${base}/payments/5?expand=all`);
    expect(found.status).toBe(200);
    expect(found.headers.get('content-type')).toBe('application/json');
    expect(found.headers.get('x-mock-api-match')).toBe('setup-1#1');
    expect(await found.json()).toEqual({ id: 5, paid: true });

    const created = await fetch(`${base}/payments`, { method: 'POST', body: '{}' });
    expect(created.status).toBe(201);
    expect(await created.text()).toBe('');
  });

  it('answers 404 with an explanation when nothing matches or no Run is active', async () => {
    const { registry, base } = await start();
    const idle = await fetch(`${base}/anything`);
    expect(idle.status).toBe(404);
    expect(await idle.json()).toMatchObject({ method: 'GET', path: '/anything', activeRuns: 0 });

    registry.register('run-1', [setup([{ path: '/known', status: 200 }])]);
    expect((await fetch(`${base}/unknown`)).status).toBe(404);
    expect((await fetch(`${base}/known`, { method: 'DELETE' })).status).toBe(200);
  });

  it('stops serving a Run that is no longer active', async () => {
    const live = new Set(['run-1']);
    const { registry, base } = await start(async (runId) => live.has(runId));
    registry.register('run-1', [setup([{ path: '/ping', status: 200, body: 'pong' }])]);
    expect((await fetch(`${base}/ping`)).status).toBe(200);
    live.delete('run-1');
    expect((await fetch(`${base}/ping`)).status).toBe(404);
    expect(registry.activeRuns).toEqual([]);
  });

  it('logs each request and the response it returned', async () => {
    const entries: Record<string, unknown>[] = [];
    const { registry, base } = await start(async () => true, {
      record: (entry) => entries.push(entry as Record<string, unknown>),
    });
    registry.register('run-1', [
      setup([{ name: 'Create', path: '/payments', method: 'POST', status: 201, body: { id: 9 } }]),
    ]);
    await fetch(`${base}/payments?dry=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer hidden' },
      body: JSON.stringify({ amount: 5 }),
    });
    await fetch(`${base}/missing`);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      method: 'POST',
      path: '/payments',
      query: '?dry=1',
      requestBody: '{"amount":5}',
      requestBodyTruncated: false,
      status: 201,
      matched: true,
      setupName: 'Gateway',
      ruleNumber: 1,
      ruleName: 'Create',
      responseBody: '{"id":9}',
    });
    expect(entries[0]?.requestHeaders).toMatchObject({ 'content-type': 'application/json' });
    expect(entries[0]?.requestHeaders).not.toHaveProperty('authorization');
    expect(entries[1]).toMatchObject({ path: '/missing', status: 404, matched: false });
  });
});
