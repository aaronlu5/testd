import { afterEach, describe, expect, it } from 'vitest';
import { createRedactor } from '@test-platform/core';
import { SqliteMockApiLog } from '../src/index.js';
import { cleanupAll, openMigrated } from './helpers.js';

afterEach(cleanupAll);

const setup = async (maxRecords?: number) => {
  const { db } = await openMigrated();
  const redactor = createRedactor({ secretValues: () => ['hunter2-secret'] });
  return new SqliteMockApiLog({ db, redactor, maxRecords });
};

const entry = (path: string, status = 200) => ({
  method: 'GET',
  path,
  query: '',
  requestHeaders: { host: '127.0.0.1:3002' },
  status,
  matched: status !== 404,
});

describe('SqliteMockApiLog', () => {
  it('stores requests newest first with the rule that answered them', async () => {
    const log = await setup();
    log.record({
      ...entry('/payments/5'),
      query: '?expand=all',
      requestBody: '{"a":1}',
      setupId: 's1',
      setupName: 'Payments',
      ruleNumber: 2,
      ruleName: 'Look up',
      responseBody: '{"ok":true}',
    });
    log.record(entry('/nothing', 404));

    const page = log.list();
    expect(page.items.map((item) => item.path)).toEqual(['/nothing', '/payments/5']);
    expect(page.total).toBe(2);
    expect(page.lastId).toBe(page.items[0]?.id);
    expect(page.items[1]).toMatchObject({
      query: '?expand=all',
      requestBody: '{"a":1}',
      requestHeaders: { host: '127.0.0.1:3002' },
      matched: true,
      setupName: 'Payments',
      ruleNumber: 2,
      ruleName: 'Look up',
      responseBody: '{"ok":true}',
    });
    expect(page.items[0]).toMatchObject({ matched: false, status: 404 });
    expect(page.items[0]).not.toHaveProperty('setupId');
  });

  it('masks secrets and caps long bodies', async () => {
    const log = await setup();
    log.record({
      ...entry('/x'),
      requestBody: `token=hunter2-secret ${'z'.repeat(6_000)}`,
      responseBody: 'y'.repeat(5_000),
    });
    const [item] = log.list().items;
    expect(item?.requestBody).not.toContain('hunter2-secret');
    expect(item?.requestBody?.length).toBeLessThanOrEqual(4_096);
    expect(item?.requestBodyTruncated).toBe(true);
    expect(item?.responseBody?.length).toBe(4_096);
  });

  it('keeps only the newest records and can be cleared', async () => {
    const log = await setup(3);
    for (let n = 1; n <= 5; n += 1) log.record(entry(`/r${n}`));
    expect(log.list().items.map((item) => item.path)).toEqual(['/r5', '/r4', '/r3']);
    expect(log.list({ limit: 2 }).items).toHaveLength(2);
    expect(log.clear()).toBe(3);
    expect(log.list()).toMatchObject({ items: [], total: 0, lastId: 0, maxRecords: 3 });
  });

  it('tracks whether the worker is serving', async () => {
    const log = await setup();
    expect(log.state()).toBeUndefined();
    log.heartbeat({
      listening: true,
      host: '127.0.0.1',
      port: 3002,
      startedAt: 'T0',
      activeRuns: 2,
    });
    expect(log.state()).toMatchObject({
      listening: true,
      host: '127.0.0.1',
      port: 3002,
      activeRuns: 2,
    });
    log.heartbeat({ listening: false, error: 'EADDRINUSE', activeRuns: 0 });
    expect(log.state()).toMatchObject({ listening: false, error: 'EADDRINUSE' });
  });
});
