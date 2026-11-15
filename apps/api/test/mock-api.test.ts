import { afterEach, describe, expect, it } from 'vitest';
import type { RunDetail, RunSummary } from '@test-platform/contracts';
import { cleanupAll, createTestApp, dataBody, ids, testBody, type TestApp } from './helpers.js';

afterEach(cleanupAll);

const setupBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'Payments gateway',
  tags: [],
  rules: [
    {
      name: 'Look up a payment',
      method: 'GET',
      path: '/payments/[0-9]+',
      status: 200,
      body: { ok: true },
    },
    { path: '/payments', method: 'POST', status: 201, body: { id: 7 } },
  ],
  ...overrides,
});

const post = (t: TestApp, url: string, payload: unknown) =>
  t.request({ method: 'POST', url, payload: payload as object });

describe('Mock API setups', () => {
  it('stores versioned setups and rejects unusable path patterns', async () => {
    const t = await createTestApp();
    const created = await ids.create(t, 'mock-setups', setupBody());
    expect(created.version).toBe(1);

    const list = t.json<{ items: { id: string; name: string }[] }>(
      await t.request({ url: '/api/v1/mock-setups' }),
    );
    expect(list.items.map((item) => item.name)).toEqual(['Payments gateway']);

    for (const path of ['/orders/(', '/a/(x+)+', 'no-slash']) {
      const bad = await post(
        t,
        '/api/v1/mock-setups',
        setupBody({ rules: [{ path, status: 200 }] }),
      );
      expect(bad.statusCode).toBe(422);
    }
    const noRules = await post(t, '/api/v1/mock-setups', setupBody({ rules: [] }));
    expect(noRules.statusCode).toBe(422);
  });

  it('reports where the Mock API server can be reached', async () => {
    const t = await createTestApp();
    const info = t.json<{ baseUrl: string; host: string; hostname: string; port: string }>(
      await t.request({ url: '/api/v1/helpers/mock-api' }),
    );
    expect(info).toEqual({
      baseUrl: 'http://127.0.0.1:3002',
      host: '127.0.0.1:3002',
      hostname: '127.0.0.1',
      port: '3002',
    });
  });

  it('saves helpers on a Test and refuses unknown setups', async () => {
    const t = await createTestApp();
    const setup = await ids.create(t, 'mock-setups', setupBody());
    const test = await ids.create(
      t,
      'tests',
      testBody({ helpers: { mockApi: { setupIds: [setup.id] } } }),
    );
    const stored = t.json<{ helpers?: { mockApi?: { setupIds: string[] } } }>(
      await t.request({ url: `/api/v1/tests/${test.id}` }),
    );
    expect(stored.helpers?.mockApi?.setupIds).toEqual([setup.id]);

    const missing = await post(
      t,
      '/api/v1/tests',
      testBody({ helpers: { mockApi: { setupIds: ['00000000-0000-4000-8000-000000000000'] } } }),
    );
    expect(missing.statusCode).toBe(422);
    expect(missing.body).toContain('/helpers/mockApi/setupIds/0');
  });

  it('freezes the setups into a Run, so later edits and deletes do not reach it', async () => {
    const t = await createTestApp();
    const setup = await ids.create(t, 'mock-setups', setupBody());
    const test = await ids.create(
      t,
      'tests',
      testBody({ helpers: { mockApi: { setupIds: [setup.id] } } }),
    );
    const data = await ids.create(t, 'test-data', dataBody());
    const run = t.json<RunSummary>(
      await post(t, '/api/v1/runs', {
        testId: test.id,
        dataSetId: data.id,
        environmentId: 'local-test',
      }),
    );
    const detail = t.json<RunDetail>(await t.request({ url: `/api/v1/runs/${run.id}` }));
    expect(detail.snapshots.mockSetups).toHaveLength(1);
    expect(detail.snapshots.mockSetups?.[0]?.rules[0]?.path).toBe('/payments/[0-9]+');

    const update = await t.request({
      method: 'PUT',
      url: `/api/v1/mock-setups/${setup.id}`,
      payload: setupBody({ version: 1, rules: [{ path: '/changed', status: 500 }] }),
    });
    expect(update.statusCode).toBe(200);
    const again = t.json<RunDetail>(await t.request({ url: `/api/v1/runs/${run.id}` }));
    expect(again.snapshots.mockSetups?.[0]?.rules[0]?.path).toBe('/payments/[0-9]+');
  });

  it('will not delete a setup that a Test or Suite uses', async () => {
    const t = await createTestApp();
    const setup = await ids.create(t, 'mock-setups', setupBody());
    const test = await ids.create(
      t,
      'tests',
      testBody({ helpers: { mockApi: { setupIds: [setup.id] } } }),
    );
    const refused = await t.request({ method: 'DELETE', url: `/api/v1/mock-setups/${setup.id}` });
    expect(refused.statusCode).toBe(409);

    await t.request({ method: 'DELETE', url: `/api/v1/tests/${test.id}` });
    const allowed = await t.request({ method: 'DELETE', url: `/api/v1/mock-setups/${setup.id}` });
    expect(allowed.statusCode).toBe(204);
  });

  it('reports whether the worker is serving the Mock API server', async () => {
    const t = await createTestApp();
    const status = async () =>
      t.json<{ running: boolean; activeRuns: number; message?: string; baseUrl: string }>(
        await t.request({ url: '/api/v1/helpers/mock-api/status' }),
      );

    expect(await status()).toMatchObject({ running: false, baseUrl: 'http://127.0.0.1:3002' });
    expect((await status()).message).toContain('has not reported');

    t.container.infra.mockApi.heartbeat({
      listening: true,
      host: '127.0.0.1',
      port: 3002,
      activeRuns: 2,
    });
    expect(await status()).toMatchObject({ running: true, activeRuns: 2 });

    t.container.infra.mockApi.heartbeat({
      listening: false,
      error: 'Port 3002 is busy.',
      activeRuns: 0,
    });
    expect(await status()).toMatchObject({ running: false, message: 'Port 3002 is busy.' });

    // A server that stops reporting counts as down.
    t.container.infra.db
      .prepare("UPDATE mock_api_state SET listening = 1, heartbeat_at = '2020-01-01T00:00:00.000Z'")
      .run();
    expect(await status()).toMatchObject({ running: false, activeRuns: 0 });
  });

  it('lists and clears the requests the server answered', async () => {
    const t = await createTestApp();
    const { mockApi } = t.container.infra;
    mockApi.record({
      method: 'GET',
      path: '/payments/1',
      query: '',
      requestHeaders: {},
      status: 200,
      matched: true,
      setupName: 'Payments',
      ruleNumber: 1,
      responseBody: '{"ok":true}',
    });
    const page = t.json<{ items: { path: string; status: number }[]; total: number }>(
      await t.request({ url: '/api/v1/helpers/mock-api/requests?limit=10' }),
    );
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ path: '/payments/1', status: 200 });

    expect((await t.request({ url: '/api/v1/helpers/mock-api/requests?limit=0' })).statusCode).toBe(
      400,
    );
    expect(
      (await t.request({ method: 'DELETE', url: '/api/v1/helpers/mock-api/requests' })).statusCode,
    ).toBe(204);
    expect(
      t.json<{ total: number }>(await t.request({ url: '/api/v1/helpers/mock-api/requests' }))
        .total,
    ).toBe(0);
  });
});
