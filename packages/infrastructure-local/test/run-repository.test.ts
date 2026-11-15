import { afterEach, describe, expect, it } from 'vitest';
import { SqliteRunRepository } from '../src/index.js';
import { cleanupAll, makeRun, makeStepRun, openMigrated } from './helpers.js';

afterEach(cleanupAll);

const setup = async () => {
  const { db } = await openMigrated();
  return new SqliteRunRepository(db);
};
const T1 = '2026-01-01T00:00:01.000Z';
const T2 = '2026-01-01T00:00:02.000Z';

describe('SqliteRunRepository runs', () => {
  it('numbers the Runs of each Test from 1 and never reuses a number', async () => {
    const runs = await setup();
    const test = (id: string, testId: string) =>
      makeRun(id, { parentRunId: undefined, test: { id: testId, version: 1 } });
    await runs.createRun(test('a1', 'test-a'));
    await runs.createRun(test('b1', 'test-b'));
    await runs.createRun(test('a2', 'test-a'));
    const number = async (id: string) => (await runs.getRun(id))?.runNumber;
    expect([await number('a1'), await number('a2'), await number('b1')]).toEqual([1, 2, 1]);
  });

  it('round-trips a run with its immutable snapshots', async () => {
    const runs = await setup();
    const original = makeRun('r1', {
      parentRunId: undefined,
      variableOverrides: { a: [1, { b: null }] },
    });
    await runs.createRun(original);
    expect(await runs.getRun('r1')).toEqual({ ...original, runNumber: 1 });
    expect(await runs.getRun('missing')).toBeUndefined();
  });

  it('lists newest first with filters and paging', async () => {
    const runs = await setup();
    await runs.createRun(makeRun('r1', { requestedAt: '2026-01-01T00:00:01.000Z' }));
    await runs.createRun(
      makeRun('r2', {
        requestedAt: '2026-01-01T00:00:02.000Z',
        status: 'Succeeded',
        environmentId: 'other',
      }),
    );
    await runs.createRun(
      makeRun('r3', { requestedAt: '2026-01-01T00:00:03.000Z', parentRunId: 'r1' }),
    );

    expect((await runs.listRuns()).map((r) => r.id)).toEqual(['r3', 'r2', 'r1']);
    expect((await runs.listRuns({ status: 'Succeeded' })).map((r) => r.id)).toEqual(['r2']);
    expect((await runs.listRuns({ environmentId: 'other' })).map((r) => r.id)).toEqual(['r2']);
    expect((await runs.listRuns({ parentRunId: 'r1' })).map((r) => r.id)).toEqual(['r3']);
    expect((await runs.listRuns({ limit: 1, offset: 1 })).map((r) => r.id)).toEqual(['r2']);
  });

  it('applies valid transitions, stamping start and finish times', async () => {
    const runs = await setup();
    await runs.createRun(makeRun('r1'));

    const started = await runs.transitionRun('r1', { from: 'Queued', to: 'Running', at: T1 });
    expect(started).toMatchObject({
      outcome: 'applied',
      current: { status: 'Running', startedAt: T1 },
    });

    const done = await runs.transitionRun('r1', {
      from: 'Running',
      to: 'Failed',
      at: T2,
      error: { code: 'EXECUTION_ASSERTION_FAILED', message: 'nope' },
    });
    expect(done.current).toMatchObject({
      status: 'Failed',
      startedAt: T1,
      finishedAt: T2,
      error: { code: 'EXECUTION_ASSERTION_FAILED' },
    });
  });

  it('is idempotent for repeated transitions and rejects stale or invalid ones', async () => {
    const runs = await setup();
    await runs.createRun(makeRun('r1'));
    await runs.transitionRun('r1', { from: 'Queued', to: 'Running', at: T1 });

    expect(
      (await runs.transitionRun('r1', { from: 'Queued', to: 'Running', at: T2 })).outcome,
    ).toBe('noop');
    expect((await runs.getRun('r1'))?.startedAt).toBe(T1);

    expect(
      (await runs.transitionRun('r1', { from: 'Queued', to: 'Cancelled', at: T2 })).outcome,
    ).toBe('rejected');
    expect(
      (await runs.transitionRun('r1', { from: ['Running'], to: 'Queued', at: T2 })).outcome,
    ).toBe('applied');
    expect(
      (await runs.transitionRun('r1', { from: 'Queued', to: 'Succeeded', at: T2 })).outcome,
    ).toBe('rejected');
    expect(
      (await runs.transitionRun('missing', { from: 'Queued', to: 'Running', at: T2 })).outcome,
    ).toBe('rejected');
  });

  it('cancels queued runs immediately and running runs cooperatively', async () => {
    const runs = await setup();
    await runs.createRun(makeRun('queued'));
    await runs.createRun(makeRun('running', { status: 'Running' }));
    await runs.createRun(makeRun('done', { status: 'Succeeded' }));

    expect(await runs.requestCancel('queued', T1)).toMatchObject({
      outcome: 'applied',
      current: { status: 'Cancelled', cancelRequestedAt: T1, finishedAt: T1 },
    });
    expect(await runs.requestCancel('running', T1)).toMatchObject({
      outcome: 'applied',
      current: { status: 'Cancelling', cancelRequestedAt: T1 },
    });
    expect((await runs.requestCancel('running', T2)).outcome).toBe('noop');
    expect((await runs.requestCancel('queued', T2)).outcome).toBe('noop');
    expect((await runs.requestCancel('done', T2)).outcome).toBe('rejected');
    expect((await runs.getRun('running'))?.cancelRequestedAt).toBe(T1);

    expect(
      (await runs.transitionRun('running', { from: 'Cancelling', to: 'Cancelled', at: T2 }))
        .outcome,
    ).toBe('applied');
  });
});

describe('SqliteRunRepository step runs', () => {
  const setupWithRun = async () => {
    const runs = await setup();
    await runs.createRun(makeRun('r1'));
    return runs;
  };

  it('stores step runs and lists them in creation order', async () => {
    const runs = await setupWithRun();
    await runs.createStepRun(makeStepRun('s2', 'r1', { nodeId: 'second' }));
    await runs.createStepRun(makeStepRun('s1', 'r1', { nodeId: 'first' }));
    expect((await runs.listStepRuns('r1')).map((s) => s.id)).toEqual(['s2', 's1']);
    await expect(
      runs.createStepRun(makeStepRun('s3', 'r1', { nodeId: 'first' })),
    ).rejects.toThrow(); // duplicate (run,node,attempt)
    await expect(runs.createStepRun(makeStepRun('s4', 'no-such-run'))).rejects.toThrow(); // foreign key
  });

  it('records results, supports the retry loop, and keeps terminal states final', async () => {
    const runs = await setupWithRun();
    await runs.createStepRun(makeStepRun('s1', 'r1'));

    expect(
      (
        await runs.updateStepRun(
          's1',
          { status: 'Running', startedAt: T1, resolvedInput: { a: 1 } },
          'Queued',
        )
      ).outcome,
    ).toBe('applied');
    const retrying = await runs.updateStepRun('s1', {
      status: 'Retrying',
      error: { code: 'TARGET_SERVICE', message: '503' },
    });
    expect(retrying.current).toMatchObject({
      status: 'Retrying',
      error: { code: 'TARGET_SERVICE' },
    });
    await runs.updateStepRun('s1', { status: 'Running' });

    const finished = await runs.updateStepRun('s1', {
      status: 'Succeeded',
      outputPreview: { ok: true },
      logs: [{ timestamp: T2, level: 'info', message: 'done' }],
      artifacts: [{ id: 'a1', contentType: 'text/plain', sizeBytes: 3 }],
      finishedAt: T2,
      durationMs: 1000,
    });
    expect(finished.current).toMatchObject({
      status: 'Succeeded',
      resolvedInput: { a: 1 },
      outputPreview: { ok: true },
      durationMs: 1000,
      logs: [{ message: 'done' }],
      artifacts: [{ id: 'a1' }],
    });

    expect((await runs.updateStepRun('s1', { status: 'Succeeded' })).outcome).toBe('noop');
    expect((await runs.updateStepRun('s1', { status: 'Running' })).outcome).toBe('rejected');
    expect((await runs.updateStepRun('s1', { durationMs: 5 })).outcome).toBe('rejected');
  });

  it('honours the expected status and rejects invalid transitions', async () => {
    const runs = await setupWithRun();
    await runs.createStepRun(makeStepRun('s1', 'r1'));
    expect((await runs.updateStepRun('s1', { status: 'Succeeded' })).outcome).toBe('rejected'); // Queued -> Succeeded
    expect((await runs.updateStepRun('s1', { status: 'Running' }, 'Running')).outcome).toBe(
      'rejected',
    ); // stale expectation
    expect((await runs.updateStepRun('missing', { status: 'Running' })).outcome).toBe('rejected');
    expect((await runs.getStepRun('s1'))?.status).toBe('Queued');
  });
});
