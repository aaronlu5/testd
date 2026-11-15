import { afterEach, describe, expect, it } from 'vitest';
import type { SuiteRun, SuiteRunItem } from '@test-platform/contracts';
import { SqliteRunRepository, SqliteSuiteRunRepository } from '../src/index.js';
import { cleanupAll, makeRun, openMigrated } from './helpers.js';

afterEach(cleanupAll);

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:00:01.000Z';
const T2 = '2026-01-01T00:00:02.000Z';

const makeSuiteRun = (
  id: string,
  maxConcurrency: number,
  overrides: Partial<SuiteRun> = {},
): SuiteRun => ({
  id,
  status: 'Queued',
  environmentId: 'local-example',
  suite: { id: 'suite-1', version: 3 },
  requestedBy: 'tester@example.test',
  requestedAt: T0,
  maxConcurrency,
  variableOverrides: { region: 'eu' },
  snapshots: {
    suite: {
      schemaVersion: 1,
      id: 'suite-1',
      version: 3,
      name: 'Smoke',
      tags: [],
      metadata: { createdAt: T0, createdBy: 'tester' },
      items: [],
    },
    tests: [],
    testData: [],
    environment: { id: 'local-example', name: 'Local', classification: 'TEST', targets: {} },
  },
  ...overrides,
});

const makeItems = (suiteRunId: string, count: number): SuiteRunItem[] =>
  Array.from({ length: count }, (_, position) => ({
    id: `${suiteRunId}-i${position}`,
    suiteRunId,
    position,
    test: { id: `test-${position}`, version: 1 },
    testData: { id: 'data-1', version: 2 },
    status: 'Pending' as const,
  }));

const setup = async (count = 4, maxConcurrency = 2) => {
  const { db } = await openMigrated();
  const suites = new SqliteSuiteRunRepository(db);
  const runs = new SqliteRunRepository(db);
  await suites.createSuiteRun({
    suiteRun: makeSuiteRun('sr1', maxConcurrency),
    items: makeItems('sr1', count),
  });
  return { db, suites, runs };
};

describe('Suite Run persistence', () => {
  it('round-trips the parent with its immutable snapshots and ordered children', async () => {
    const { suites } = await setup(3);
    expect(await suites.getSuiteRun('sr1')).toEqual(makeSuiteRun('sr1', 2));
    expect((await suites.listItems('sr1')).map((i) => [i.position, i.test.id, i.status])).toEqual([
      [0, 'test-0', 'Pending'],
      [1, 'test-1', 'Pending'],
      [2, 'test-2', 'Pending'],
    ]);
    expect(await suites.counts('sr1')).toMatchObject({ total: 3, Pending: 3, Running: 0 });
    expect((await suites.listSuiteRuns()).map((s) => s.id)).toEqual(['sr1']);
    expect(await suites.listSuiteRuns({ status: 'Running' })).toEqual([]);
  });

  it('creates the parent and children atomically', async () => {
    const { suites } = await setup(1);
    // Duplicate item position fails the whole create; no orphan parent remains.
    const items = makeItems('sr2', 2).map((item) => ({ ...item, position: 0 }));
    await expect(
      suites.createSuiteRun({ suiteRun: makeSuiteRun('sr2', 1), items }),
    ).rejects.toThrow();
    expect(await suites.getSuiteRun('sr2')).toBeUndefined();
  });

  it('transitions the parent with guards and timestamps', async () => {
    const { suites } = await setup();
    expect(
      await suites.transitionSuiteRun('sr1', { from: 'Queued', to: 'Running', at: T1 }),
    ).toMatchObject({
      outcome: 'applied',
      current: { status: 'Running', startedAt: T1 },
    });
    expect(
      await suites.transitionSuiteRun('sr1', { from: 'Queued', to: 'Running', at: T2 }),
    ).toMatchObject({
      outcome: 'noop',
    });
    expect(
      await suites.transitionSuiteRun('sr1', {
        from: 'Running',
        to: 'WaitingForBreakpoint',
        at: T2,
      }),
    ).toMatchObject({ outcome: 'applied' });
    expect(
      await suites.transitionSuiteRun('sr1', {
        from: 'WaitingForBreakpoint',
        to: 'Cancelling',
        at: T2,
      }),
    ).toMatchObject({ outcome: 'applied', current: { cancelRequestedAt: T2 } });
    expect(
      await suites.transitionSuiteRun('sr1', { from: 'Cancelling', to: 'Cancelled', at: T2 }),
    ).toMatchObject({ outcome: 'applied', current: { status: 'Cancelled', finishedAt: T2 } });
    // Terminal parents never revert.
    expect(
      await suites.transitionSuiteRun('sr1', { from: 'Cancelled', to: 'Running', at: T2 }),
    ).toMatchObject({ outcome: 'rejected' });
    expect(
      await suites.transitionSuiteRun('missing', { from: 'Queued', to: 'Running', at: T1 }),
    ).toEqual({
      outcome: 'rejected',
    });
  });

  it('never dispatches more items than maxConcurrency, in position order', async () => {
    const { suites } = await setup(4, 2);
    const first = await suites.claimPendingItems('sr1', T1);
    expect(first.map((i) => [i.position, i.status, i.dispatchedAt])).toEqual([
      [0, 'Queued', T1],
      [1, 'Queued', T1],
    ]);
    // Both slots are held, so a repeated claim (for example after a restart) adds nothing.
    expect(await suites.claimPendingItems('sr1', T1)).toEqual([]);

    await suites.updateItem('sr1-i0', { status: 'Running', runId: undefined, at: T1 });
    expect(await suites.claimPendingItems('sr1', T1)).toEqual([]);
    await suites.updateItem('sr1-i0', { status: 'Succeeded', at: T2 });
    const next = await suites.claimPendingItems('sr1', T2);
    expect(next.map((i) => i.position)).toEqual([2]);
    expect(await suites.counts('sr1')).toMatchObject({ Succeeded: 1, Queued: 2, Pending: 1 });
  });

  it('keeps a paused child in its slot so the limit is respected', async () => {
    const { suites } = await setup(3, 1);
    await suites.claimPendingItems('sr1', T1);
    await suites.updateItem('sr1-i0', { status: 'Running', at: T1 });
    await suites.updateItem('sr1-i0', { status: 'Paused', at: T1 });
    expect(await suites.claimPendingItems('sr1', T2)).toEqual([]);
    await suites.updateItem('sr1-i0', { status: 'Queued', at: T2 }); // resumed
    await suites.updateItem('sr1-i0', { status: 'Running', at: T2 });
    await suites.updateItem('sr1-i0', { status: 'Succeeded', at: T2 });
    expect((await suites.claimPendingItems('sr1', T2)).map((i) => i.position)).toEqual([1]);
  });

  it('dispatches nothing once cancellation was requested or the parent is final', async () => {
    const { suites } = await setup();
    await suites.transitionSuiteRun('sr1', { from: 'Queued', to: 'Cancelled', at: T1 });
    expect(await suites.claimPendingItems('sr1', T2)).toEqual([]);
    expect(await suites.claimPendingItems('missing', T2)).toEqual([]);
  });

  it('links child Runs and guards item transitions', async () => {
    const { suites, runs } = await setup();
    await runs.createRun(makeRun('child-0'));
    await suites.claimPendingItems('sr1', T1);

    const linked = await suites.updateItem(
      'sr1-i0',
      { status: 'Running', runId: 'child-0', at: T1 },
      'Queued',
    );
    expect(linked).toMatchObject({
      outcome: 'applied',
      current: { runId: 'child-0', status: 'Running' },
    });
    expect(await suites.findItemByRunId('child-0')).toMatchObject({ id: 'sr1-i0', position: 0 });
    expect(await suites.findItemByRunId('nope')).toBeUndefined();

    // Wrong expected status, invalid jump, and terminal repeats.
    expect(
      await suites.updateItem('sr1-i0', { status: 'Succeeded', at: T2 }, 'Queued'),
    ).toMatchObject({
      outcome: 'rejected',
    });
    expect(await suites.updateItem('sr1-i2', { status: 'Succeeded', at: T2 })).toMatchObject({
      outcome: 'rejected',
    }); // Pending -> Succeeded is not allowed
    await suites.updateItem('sr1-i0', { status: 'Succeeded', at: T2 });
    expect(await suites.updateItem('sr1-i0', { status: 'Succeeded', at: T2 })).toMatchObject({
      outcome: 'noop',
    });
    expect((await suites.listItems('sr1'))[0]).toMatchObject({ finishedAt: T2, runId: 'child-0' });
    expect(await suites.updateItem('missing', { status: 'Queued', at: T1 })).toEqual({
      outcome: 'rejected',
    });
  });
});
