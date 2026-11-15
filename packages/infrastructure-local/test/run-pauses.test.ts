import { afterEach, describe, expect, it } from 'vitest';
import type { NewRunPause } from '@test-platform/core';
import {
  SqliteAuditLog,
  SqliteJobQueue,
  SqliteRunEvents,
  SqliteRunPauseRepository,
  SqliteRunRepository,
} from '../src/index.js';
import { FakeClock, cleanupAll, makeRun, makeStepRun, openMigrated } from './helpers.js';

afterEach(cleanupAll);

const PAUSE: NewRunPause = {
  breakpointNodeId: 'inspect',
  message: 'Review the payload.',
  nextNodeId: 'verify',
  nextNodeName: 'Verify status',
  nextNodeType: 'assert',
  nextResolvedInputPreview: { actual: 200, token: '***REDACTED***' },
  pausedAt: '2026-01-01T00:00:10.000Z',
};
const T_RESUME = '2026-01-01T00:01:00.000Z';

/** A Run mid-flight: Delay done, Breakpoint Step Running, job leased by `worker-1`. */
const setup = async () => {
  const { db } = await openMigrated();
  const clock = new FakeClock('2026-01-01T00:00:05.000Z');
  const runs = new SqliteRunRepository(db);
  const jobs = new SqliteJobQueue(db, clock);
  const events = new SqliteRunEvents(db);
  const audit = new SqliteAuditLog(db, clock);
  const pauses = new SqliteRunPauseRepository({ db, jobs, events, audit, clock });

  await runs.createRun(makeRun('r1'));
  await jobs.enqueue({ runId: 'r1' });
  const job = (await jobs.claim({ workerId: 'worker-1', leaseMs: 60_000 }))!;
  await runs.transitionRun('r1', { from: 'Queued', to: 'Running', at: clock.iso() });
  await runs.createStepRun(
    makeStepRun('s-delay', 'r1', { nodeId: 'delay', status: 'Running', startedAt: clock.iso() }),
  );
  await runs.updateStepRun('s-delay', {
    status: 'Succeeded',
    outputPreview: { waited: 1 },
    finishedAt: clock.iso(),
    durationMs: 1000,
  });
  await runs.createStepRun(makeStepRun('s-bp', 'r1', { nodeId: 'inspect', status: 'Running' }));

  const pause = (overrides: Partial<Parameters<typeof pauses.pauseRun>[0]> = {}) =>
    pauses.pauseRun({
      runId: 'r1',
      jobId: job.id,
      workerId: 'worker-1',
      breakpointStepRunId: 's-bp',
      pause: PAUSE,
      ...overrides,
    });
  const eventTypes = async (): Promise<string[]> =>
    (await events.listSince('r1')).map((event) => event.type);
  return { db, clock, runs, jobs, events, pauses, job, pause, eventTypes };
};

describe('pauseRun', () => {
  it('pauses the Run and Step Run, releases the lease, and publishes events in one commit', async () => {
    const ctx = await setup();
    const result = await ctx.pause();

    expect(result.outcome).toBe('applied');
    if (result.outcome !== 'applied') return;
    expect(result.run).toMatchObject({ status: 'Paused', pausedAt: PAUSE.pausedAt });
    expect(result.run.continuationGeneration).toBeUndefined(); // generation 0 is omitted
    expect(result.pause).toMatchObject({
      runId: 'r1',
      breakpointStepRunId: 's-bp',
      breakpointNodeId: 'inspect',
      message: 'Review the payload.',
      nextNodeId: 'verify',
      nextNodeName: 'Verify status',
      nextNodeType: 'assert',
      nextResolvedInputPreview: { actual: 200, token: '***REDACTED***' },
      continuationGeneration: 0,
    });
    expect((await ctx.runs.getStepRun('s-bp'))?.status).toBe('Paused');

    const job = await ctx.jobs.get(ctx.job.id);
    expect(job).toMatchObject({ status: 'completed' });
    expect(job?.leaseOwner).toBeUndefined();
    expect(await ctx.eventTypes()).toEqual([
      'step.status',
      'run.step.updated',
      'run.status',
      'run.paused',
    ]);
    expect(await ctx.pauses.getActivePause('r1')).toEqual(result.pause);
  });

  it('supports a Breakpoint at the end of the flow (no successor)', async () => {
    const ctx = await setup();
    const result = await ctx.pause({
      pause: { breakpointNodeId: 'inspect', nextNodeId: null, pausedAt: PAUSE.pausedAt },
    });
    expect(result.outcome).toBe('applied');
    expect((await ctx.pauses.getActivePause('r1'))?.nextNodeId).toBeNull();
  });

  it('rejects a worker that lost its lease, with no state change', async () => {
    const ctx = await setup();
    expect(await ctx.pause({ workerId: 'worker-2' })).toEqual({
      outcome: 'rejected',
      reason: 'lease-lost',
    });
    ctx.clock.advance(120_000); // lease expired
    expect(await ctx.pause()).toEqual({ outcome: 'rejected', reason: 'lease-lost' });
    expect((await ctx.runs.getRun('r1'))?.status).toBe('Running');
    expect(await ctx.pauses.getActivePause('r1')).toBeUndefined();
  });

  it('does not overwrite a cancellation that arrived first', async () => {
    const ctx = await setup();
    await ctx.runs.requestCancel('r1', '2026-01-01T00:00:08.000Z'); // Running -> Cancelling
    expect(await ctx.pause()).toEqual({ outcome: 'rejected', reason: 'run-not-running' });
    expect((await ctx.runs.getRun('r1'))?.status).toBe('Cancelling');
    expect((await ctx.runs.getStepRun('s-bp'))?.status).toBe('Running');
  });

  it('rejects a Step Run that is not the running Breakpoint', async () => {
    const ctx = await setup();
    expect(await ctx.pause({ breakpointStepRunId: 's-delay' })).toEqual({
      outcome: 'rejected',
      reason: 'step-not-running',
    });
    expect(await ctx.pause({ breakpointStepRunId: 'missing' })).toEqual({
      outcome: 'rejected',
      reason: 'step-not-running',
    });
  });

  it('is atomic: a failure while recording rolls back every earlier write', async () => {
    const ctx = await setup();
    // An orphaned active pause makes the INSERT fail after validation succeeded.
    ctx.db
      .prepare(
        `INSERT INTO run_pauses (id, run_id, breakpoint_step_run_id, breakpoint_node_id, paused_at, continuation_generation)
         VALUES ('stale', 'r1', 's-bp', 'inspect', '2026-01-01T00:00:00.000Z', 5)`,
      )
      .run();
    await expect(ctx.pause()).rejects.toThrow();
    expect((await ctx.runs.getRun('r1'))?.status).toBe('Running');
    expect((await ctx.runs.getStepRun('s-bp'))?.status).toBe('Running');
    expect(await ctx.jobs.get(ctx.job.id)).toMatchObject({
      status: 'leased',
      leaseOwner: 'worker-1',
    });
    expect(await ctx.eventTypes()).toEqual([]);
  });
});

describe('resumeRun', () => {
  it('requeues the same Run with an incremented generation and one new job', async () => {
    const ctx = await setup();
    await ctx.pause();

    const result = await ctx.pauses.resumeRun({ runId: 'r1', at: T_RESUME, expectedGeneration: 0 });
    expect(result.outcome).toBe('applied');
    if (result.outcome !== 'applied') return;
    expect(result.run).toMatchObject({ id: 'r1', status: 'Queued', continuationGeneration: 1 });
    expect(result.run.pausedAt).toBeUndefined();
    expect(result.pause).toMatchObject({ resumedAt: T_RESUME, continuationGeneration: 0 });
    expect(result.job).toMatchObject({ runId: 'r1', status: 'queued' });

    // The Breakpoint attempt stays Paused until the worker completes it on continuation.
    expect((await ctx.runs.getStepRun('s-bp'))?.status).toBe('Paused');
    expect(await ctx.pauses.getActivePause('r1')).toBeUndefined();
    expect(await ctx.eventTypes()).toEqual([
      'step.status',
      'run.step.updated',
      'run.status',
      'run.paused',
      'run.status',
      'run.resumed',
    ]);
    const resumed = (await ctx.events.listSince('r1')).at(-1);
    expect(resumed).toMatchObject({ type: 'run.resumed', data: { continuationGeneration: 1 } });
  });

  it('is idempotent for one generation: repeat clicks queue exactly one continuation', async () => {
    const ctx = await setup();
    await ctx.pause();

    const results = await Promise.all([
      ctx.pauses.resumeRun({ runId: 'r1', at: T_RESUME, expectedGeneration: 0 }),
      ctx.pauses.resumeRun({ runId: 'r1', at: T_RESUME, expectedGeneration: 0 }),
      ctx.pauses.resumeRun({ runId: 'r1', at: T_RESUME, expectedGeneration: 0 }),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['applied', 'noop', 'noop']);

    const queued = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE run_id = 'r1' AND status = 'queued'")
      .get() as { n: number };
    expect(queued.n).toBe(1);
    expect((await ctx.runs.getRun('r1'))?.continuationGeneration).toBe(1);
  });

  it('rejects a resume against a newer pause as stale', async () => {
    const ctx = await setup();
    await ctx.pause();
    await ctx.pauses.resumeRun({ runId: 'r1', at: T_RESUME, expectedGeneration: 0 });

    // The continuation ran, then paused again at a second Breakpoint (generation 1).
    await ctx.runs.transitionRun('r1', { from: 'Queued', to: 'Running', at: T_RESUME });
    await ctx.runs.updateStepRun('s-bp', { status: 'Succeeded' });
    await ctx.runs.createStepRun(
      makeStepRun('s-bp2', 'r1', { nodeId: 'inspect2', status: 'Running' }),
    );
    await ctx.jobs.enqueue({ runId: 'r1' });
    ctx.db
      .prepare("UPDATE jobs SET status = 'completed' WHERE status = 'queued' AND run_id = 'r1'")
      .run();
    await ctx.jobs.enqueue({ runId: 'r1' });
    const job2 = (await ctx.jobs.claim({ workerId: 'worker-1', leaseMs: 60_000 }))!;
    const second = await ctx.pauses.pauseRun({
      runId: 'r1',
      jobId: job2.id,
      workerId: 'worker-1',
      breakpointStepRunId: 's-bp2',
      pause: { ...PAUSE, breakpointNodeId: 'inspect2', pausedAt: '2026-01-01T00:02:00.000Z' },
    });
    expect(second.outcome).toBe('applied');

    expect(
      await ctx.pauses.resumeRun({ runId: 'r1', at: T_RESUME, expectedGeneration: 0 }),
    ).toMatchObject({
      outcome: 'rejected',
      reason: 'stale-generation',
    });
    expect((await ctx.runs.getRun('r1'))?.status).toBe('Paused');
    expect(
      await ctx.pauses.resumeRun({ runId: 'r1', at: T_RESUME, expectedGeneration: 1 }),
    ).toMatchObject({ outcome: 'applied' });
    expect((await ctx.pauses.listPauses('r1')).map((p) => p.continuationGeneration)).toEqual([
      0, 1,
    ]);
  });

  it('rejects runs that are missing or not paused', async () => {
    const ctx = await setup();
    expect(await ctx.pauses.resumeRun({ runId: 'nope', at: T_RESUME })).toEqual({
      outcome: 'rejected',
      reason: 'not-found',
    });
    expect(await ctx.pauses.resumeRun({ runId: 'r1', at: T_RESUME })).toMatchObject({
      outcome: 'rejected',
      reason: 'not-paused',
    });
    await ctx.pause();
    await ctx.pauses.resumeRun({ runId: 'r1', at: T_RESUME });
    // Without an expected generation a repeat cannot be matched to a continuation.
    expect(await ctx.pauses.resumeRun({ runId: 'r1', at: T_RESUME })).toMatchObject({
      outcome: 'rejected',
      reason: 'not-paused',
    });
  });
});

describe('cancelPausedRun', () => {
  it('cancels the Run and its Breakpoint Step Run and queues nothing', async () => {
    const ctx = await setup();
    await ctx.pause();

    const result = await ctx.pauses.cancelPausedRun({ runId: 'r1', at: T_RESUME });
    expect(result.outcome).toBe('applied');
    if (result.outcome !== 'applied') return;
    expect(result.run).toMatchObject({
      status: 'Cancelled',
      cancelRequestedAt: T_RESUME,
      finishedAt: T_RESUME,
    });
    expect(result.run.pausedAt).toBeUndefined();
    expect(result.pause.cancelledAt).toBe(T_RESUME);
    expect(await ctx.runs.getStepRun('s-bp')).toMatchObject({
      status: 'Cancelled',
      finishedAt: T_RESUME,
    });
    expect(await ctx.pauses.getActivePause('r1')).toBeUndefined();
    const queued = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'")
      .get() as {
      n: number;
    };
    expect(queued.n).toBe(0);
    expect((await ctx.eventTypes()).slice(-4)).toEqual([
      'step.status',
      'run.step.updated',
      'run.status',
      'run.cancelled',
    ]);
  });

  it('is idempotent and blocks a later resume', async () => {
    const ctx = await setup();
    await ctx.pause();
    await ctx.pauses.cancelPausedRun({ runId: 'r1', at: T_RESUME });
    expect(await ctx.pauses.cancelPausedRun({ runId: 'r1', at: T_RESUME })).toMatchObject({
      outcome: 'noop',
    });
    expect(
      await ctx.pauses.resumeRun({ runId: 'r1', at: T_RESUME, expectedGeneration: 0 }),
    ).toMatchObject({ outcome: 'rejected', reason: 'not-paused' });
    expect((await ctx.runs.getRun('r1'))?.status).toBe('Cancelled');
  });

  it('rejects a Run that is not paused', async () => {
    const ctx = await setup();
    expect(await ctx.pauses.cancelPausedRun({ runId: 'r1', at: T_RESUME })).toMatchObject({
      outcome: 'rejected',
      reason: 'not-paused',
    });
    expect(await ctx.pauses.cancelPausedRun({ runId: 'x', at: T_RESUME })).toEqual({
      outcome: 'rejected',
      reason: 'not-found',
    });
  });
});

describe('inspection and persistence', () => {
  it('lists completed Step summaries, excluding the paused Breakpoint', async () => {
    const ctx = await setup();
    await ctx.pause();
    expect(await ctx.pauses.listCompletedSteps('r1')).toEqual([
      expect.objectContaining({
        id: 's-delay',
        nodeId: 'delay',
        status: 'Succeeded',
        outputPreview: { waited: 1 },
        durationMs: 1000,
      }),
    ]);
  });

  it('round-trips pause and generation fields on the Run itself', async () => {
    const { db } = await openMigrated();
    const runs = new SqliteRunRepository(db);
    const original = makeRun('r9', {
      status: 'Paused',
      pausedAt: '2026-01-01T00:00:10.000Z',
      continuationGeneration: 2,
    });
    await runs.createRun(original);
    expect(await runs.getRun('r9')).toEqual({ ...original, runNumber: 1 });

    await runs.transitionRun('r9', { from: 'Paused', to: 'Queued', at: T_RESUME });
    const queued = await runs.getRun('r9');
    expect(queued?.pausedAt).toBeUndefined();
    expect(queued?.continuationGeneration).toBe(2);
  });

  it('keeps Paused out of the terminal states', async () => {
    const { db } = await openMigrated();
    const runs = new SqliteRunRepository(db);
    await runs.createRun(makeRun('r1', { status: 'Running' }));
    expect(
      await runs.transitionRun('r1', { from: 'Running', to: 'Paused', at: T_RESUME }),
    ).toMatchObject({ outcome: 'applied', current: { status: 'Paused', pausedAt: T_RESUME } });
    expect((await runs.getRun('r1'))?.finishedAt).toBeUndefined();
    // A generic cancel request does not bypass the pause-aware command.
    expect(await runs.requestCancel('r1', T_RESUME)).toMatchObject({ outcome: 'rejected' });
  });
});
