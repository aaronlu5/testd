import { afterEach, describe, expect, it } from 'vitest';
import type { Run, StepRun } from '@test-platform/contracts';
import { newId } from '@test-platform/infrastructure-local';
import {
  FakeClock,
  cleanupAll,
  createHarness,
  createTestRegistry,
  eventsOf,
  makeRun,
  newTestState,
  node,
  runStatuses,
  stepRuns,
  submit,
  waitFor,
  type Harness,
} from './helpers.js';

afterEach(cleanupAll);

/** Simulates a worker that crashed mid-Run: job leased, Run Running, Step rows left behind. */
const crashMidRun = async (
  h: Harness,
  run: Run,
  rows: Partial<StepRun>[],
  workerId = 'dead-worker',
) => {
  const { job } = await submit(h.container, run);
  const claimed = await h.container.infra.jobs.claim({ workerId, leaseMs: h.config.leaseMs });
  expect(claimed?.id).toBe(job.id);
  await h.container.infra.runs.transitionRun(run.id, {
    from: 'Queued',
    to: 'Running',
    at: '2026-01-01T00:00:00.000Z',
  });
  await h.container.infra.events.publish({
    type: 'run.status',
    runId: run.id,
    timestamp: '2026-01-01T00:00:00.000Z',
    data: { status: 'Running' },
  });
  for (const row of rows) {
    await h.container.infra.runs.createStepRun({
      id: newId(),
      runId: run.id,
      attempt: 1,
      logs: [],
      artifacts: [],
      startedAt: '2026-01-01T00:00:00.000Z',
      ...row,
    } as StepRun);
  }
  return job;
};

describe('lease recovery', () => {
  it('requeues an expired job and resumes the Run, reusing finished Steps', async () => {
    const clock = new FakeClock();
    const h = await createHarness({ clock });
    const run = makeRun([
      node('shape', 'transform.json', { input: { id: 'A' }, mapping: { id: '$.id' } }),
      node('wait', 'delay', { durationSeconds: 0.01 }),
      node('verify', 'assert', {
        actual: '{{steps.shape.output.id}}',
        operator: 'equals',
        expected: 'A',
      }),
    ]);
    const job = await crashMidRun(h, run, [
      { nodeId: 'shape', status: 'Succeeded', outputPreview: { id: 'A' } },
      { nodeId: 'wait', status: 'Running' },
    ]);

    // Within the lease nothing is available to claim.
    expect(await h.container.loop.runOnce()).toBe(false);
    expect(await h.container.infra.jobs.get(job.id)).toMatchObject({
      status: 'leased',
      leaseOwner: 'dead-worker',
    });

    clock.advance(h.config.leaseMs + 1);
    expect(await h.container.loop.runOnce()).toBe(true);

    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({ status: 'Succeeded' });
    expect(await h.container.infra.jobs.get(job.id)).toMatchObject({
      status: 'completed',
      attempts: 2,
    });

    const steps = await stepRuns(h.container, run.id);
    expect(steps.map((step) => [step.nodeId, step.attempt, step.status])).toEqual([
      ['shape', 1, 'Succeeded'],
      ['verify', 1, 'Succeeded'],
      ['wait', 1, 'Failed'],
      ['wait', 2, 'Succeeded'],
    ]);
    expect(steps.find((step) => step.nodeId === 'wait' && step.attempt === 1)?.error).toMatchObject(
      { code: 'EXECUTION_LEASE' },
    );
    // The finished Step was not executed again.
    expect(steps.filter((step) => step.nodeId === 'shape')).toHaveLength(1);
    // The resumed Run does not announce a second start.
    expect(runStatuses(await eventsOf(h.container, run.id))).toEqual([
      'Queued',
      'Running',
      'Succeeded',
    ]);
  });

  it('fails the job when attempts are exhausted by repeated lease expiry', async () => {
    const clock = new FakeClock();
    const h = await createHarness({ clock });
    const run = makeRun([node('wait', 'delay', { durationSeconds: 0.01 })]);
    const { job } = await h.container.infra.commands.submit({ run, maxAttempts: 1 });
    await h.container.infra.jobs.claim({ workerId: 'dead-worker', leaseMs: h.config.leaseMs });

    clock.advance(h.config.leaseMs + 1);
    await h.container.loop.runOnce();

    expect(await h.container.infra.jobs.get(job.id)).toMatchObject({ status: 'failed' });
  });

  it('does not replay an interrupted external Step whose retry policy is exhausted', async () => {
    const clock = new FakeClock();
    const state = newTestState();
    const h = await createHarness({ clock, registry: createTestRegistry(state) });
    const run = makeRun([node('call', 'external')]);
    await crashMidRun(h, run, [{ nodeId: 'call', status: 'Running' }]);

    clock.advance(h.config.leaseMs + 1);
    await h.container.loop.runOnce();

    expect(state.externalCalls).toBe(0);
    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({
      status: 'Failed',
      error: { code: 'EXECUTION_LEASE' },
    });
  });

  it('resumes after a crash between a Step failing and the Run failing', async () => {
    const clock = new FakeClock();
    const h = await createHarness({ clock });
    const run = makeRun([node('check', 'assert', { actual: 1, operator: 'equals', expected: 2 })]);
    await crashMidRun(h, run, [
      {
        nodeId: 'check',
        status: 'Failed',
        error: { code: 'EXECUTION_ASSERTION_FAILED', message: 'Expected 1 to equal 2.' },
      },
    ]);
    clock.advance(h.config.leaseMs + 1);
    await h.container.loop.runOnce();

    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({
      status: 'Failed',
      error: { code: 'EXECUTION_ASSERTION_FAILED' },
    });
    expect(await stepRuns(h.container, run.id)).toHaveLength(1);
  });

  it('continues with the next attempt after a crash during retry backoff', async () => {
    const clock = new FakeClock();
    const state = newTestState();
    const h = await createHarness({ clock, registry: createTestRegistry(state) });
    const run = makeRun([
      node('call', 'flaky', {}, { retry: { maxAttempts: 3, initialDelayMs: 1 } }),
    ]);
    await crashMidRun(h, run, [
      { nodeId: 'call', status: 'Retrying', error: { code: 'TARGET_SERVICE', message: 'down' } },
    ]);
    clock.advance(h.config.leaseMs + 1);
    await h.container.loop.runOnce();

    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({ status: 'Succeeded' });
    expect(
      (await stepRuns(h.container, run.id)).map((step) => [step.attempt, step.status]),
    ).toEqual([
      [1, 'Retrying'],
      [2, 'Succeeded'],
    ]);
  });

  it('finishes cancelling a Run that was Cancelling when the worker died', async () => {
    const clock = new FakeClock();
    const h = await createHarness({ clock });
    const run = makeRun([node('wait', 'delay', { durationSeconds: 60 })]);
    await crashMidRun(h, run, [{ nodeId: 'wait', status: 'Running' }]);
    await h.container.infra.commands.requestCancel({
      runId: run.id,
      at: clock.now().toISOString(),
    });

    clock.advance(h.config.leaseMs + 1);
    await h.container.loop.runOnce();

    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({ status: 'Cancelled' });
    expect(runStatuses(await eventsOf(h.container, run.id)).at(-1)).toBe('Cancelled');
  });
});

describe('graceful shutdown', () => {
  it('hands the job back mid-Run and lets another worker resume it', async () => {
    const state = newTestState();
    state.hold = true;
    const h = await createHarness({ registry: createTestRegistry(state) });
    const run = makeRun([node('gate', 'gate'), node('after', 'delay', { durationSeconds: 0.01 })]);
    const { job } = await submit(h.container, run);

    h.container.loop.start();
    await waitFor(async () => (await stepRuns(h.container, run.id))[0]?.status === 'Running');
    await h.container.loop.stop(0);

    expect(await h.container.infra.jobs.get(job.id)).toMatchObject({ status: 'queued' });
    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({ status: 'Running' });

    state.hold = false;
    const other = h.second('worker-b', createTestRegistry(state));
    expect(await other.loop.runOnce()).toBe(true);

    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({ status: 'Succeeded' });
    expect(
      (await stepRuns(h.container, run.id)).map((step) => [step.nodeId, step.attempt, step.status]),
    ).toEqual([
      ['after', 1, 'Succeeded'],
      ['gate', 1, 'Failed'],
      ['gate', 2, 'Succeeded'],
    ]);
    expect(await h.container.infra.jobs.get(job.id)).toMatchObject({ status: 'completed' });
  });

  it('waits for the active Run to finish within the grace period', async () => {
    const h = await createHarness();
    const run = makeRun([node('wait', 'delay', { durationSeconds: 0.2 })]);
    await submit(h.container, run);

    h.container.loop.start();
    await waitFor(async () => (await stepRuns(h.container, run.id))[0]?.status === 'Running');
    await h.container.loop.stop(5_000);

    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({ status: 'Succeeded' });
  });
});

describe('lease ownership', () => {
  it('abandons the Run without writing when the lease is taken over', async () => {
    const state = newTestState();
    state.hold = true;
    const h = await createHarness({
      registry: createTestRegistry(state),
      env: {
        TEST_PLATFORM_WORKER_LEASE_MS: '200',
        TEST_PLATFORM_WORKER_LEASE_RENEW_MS: '20',
      },
    });
    const run = makeRun([node('gate', 'gate')]);
    const { job } = await submit(h.container, run);
    const working = h.container.loop.runOnce();
    await waitFor(async () => (await stepRuns(h.container, run.id))[0]?.status === 'Running');

    h.container.infra.db.prepare("UPDATE jobs SET lease_owner = 'thief' WHERE id = ?").run(job.id);
    await working;

    expect(await h.container.infra.jobs.get(job.id)).toMatchObject({
      status: 'leased',
      leaseOwner: 'thief',
    });
    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({ status: 'Running' });
    state.hold = false;
  });

  it('keeps the lease alive while a long Step runs', async () => {
    const h = await createHarness({
      env: {
        TEST_PLATFORM_WORKER_LEASE_MS: '150',
        TEST_PLATFORM_WORKER_LEASE_RENEW_MS: '30',
      },
    });
    const run = makeRun([node('wait', 'delay', { durationSeconds: 0.5 })]);
    const { job } = await submit(h.container, run);
    const working = h.container.loop.runOnce();
    await waitFor(async () => (await stepRuns(h.container, run.id))[0]?.status === 'Running');
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Past the original lease, yet the job is still ours and nobody can recover it.
    expect(await h.container.infra.jobs.recoverExpired()).toEqual({ requeued: 0, failed: 0 });
    await working;
    expect(await h.container.infra.jobs.get(job.id)).toMatchObject({ status: 'completed' });
  });
});

describe('polling loop', () => {
  it('claims jobs that appear after it started', async () => {
    const h = await createHarness();
    h.container.loop.start();
    const run = makeRun([node('wait', 'delay', { durationSeconds: 0.01 })]);
    await submit(h.container, run);

    await waitFor(
      async () => (await h.container.infra.runs.getRun(run.id))?.status === 'Succeeded',
    );
    await h.container.loop.stop();
  });

  it('lets two workers share a queue without running a Run twice', async () => {
    const h = await createHarness();
    const other = h.second('worker-b');
    const runs = Array.from({ length: 6 }, () =>
      makeRun([node('wait', 'delay', { durationSeconds: 0.01 })]),
    );
    for (const run of runs) await submit(h.container, run);

    h.container.loop.start();
    other.loop.start();
    await waitFor(async () => {
      const states = await Promise.all(runs.map((run) => h.container.infra.runs.getRun(run.id)));
      return states.every((state) => state?.status === 'Succeeded');
    });
    await Promise.all([h.container.loop.stop(), other.loop.stop()]);

    for (const run of runs) {
      expect(await stepRuns(h.container, run.id)).toHaveLength(1);
      expect(runStatuses(await eventsOf(h.container, run.id))).toEqual([
        'Queued',
        'Running',
        'Succeeded',
      ]);
    }
  });
});
