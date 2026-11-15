import { afterEach, describe, expect, it } from 'vitest';
import type {
  EnvironmentConfig,
  SuiteAsset,
  SuiteRun,
  TestDataAsset,
  TestDefinition,
  TestNode,
} from '@test-platform/contracts';
import { activeSuiteItemCount, buildSuiteRunPlan, planSuiteRerun } from '@test-platform/core';
import { newId } from '@test-platform/infrastructure-local';
import {
  FakeClock,
  cleanupAll,
  chain,
  createHarness,
  environment,
  node,
  stepRuns,
  type Harness,
} from './helpers.js';

afterEach(cleanupAll);

const AT = '2026-01-01T00:00:00.000Z';
const meta = { createdAt: AT, createdBy: 'tester' };
const fast = (id: string) => node(id, 'delay', { durationSeconds: 0.001 });
const failing = (id: string) => node(id, 'assert', { actual: 1, operator: 'equals', expected: 2 });
const withBreakpoint = (id: string) => [
  fast(`${id}-before`),
  node(`${id}-inspect`, 'breakpoint', { enabled: true }),
  node(`${id}-after`, 'assert', { actual: 1, operator: 'equals', expected: 1 }),
];

type Spec = { id: string; nodes: TestNode[]; version?: number };

const testDef = (spec: Spec): TestDefinition => ({
  schemaVersion: 1,
  id: spec.id,
  version: spec.version ?? 1,
  name: spec.id,
  tags: [],
  metadata: meta,
  variables: {},
  ...chain(...spec.nodes),
});
const dataDef = (id: string, data: Record<string, unknown> = {}): TestDataAsset => ({
  schemaVersion: 1,
  id,
  version: 1,
  name: id,
  tags: [],
  metadata: meta,
  data: data as never,
});

type SuiteOptions = {
  concurrency?: number;
  envLimit?: number;
  env?: Partial<EnvironmentConfig>;
};

const submitSuite = async (h: Harness, specs: Spec[], options: SuiteOptions = {}) => {
  const env = environment({
    ...(options.envLimit !== undefined
      ? { limits: { maxSuiteConcurrency: options.envLimit } }
      : {}),
    ...options.env,
  });
  const suite: SuiteAsset = {
    schemaVersion: 1,
    id: 'suite-1',
    version: 1,
    name: 'Suite',
    tags: [],
    metadata: meta,
    items: specs.map((spec) => ({ testId: spec.id, dataSetId: 'data-1' })),
  };
  const plan = buildSuiteRunPlan({
    suite,
    tests: specs.map(testDef),
    testData: [dataDef('data-1')],
    environment: env,
    requestedBy: 'tester',
    requestedAt: AT,
    requestedConcurrency: options.concurrency,
    newId,
  });
  await h.container.infra.suiteCommands.submit(plan);
  return plan;
};

const counts = (h: Harness, id: string) => h.container.infra.suiteRuns.counts(id);
const suiteOf = async (h: Harness, id: string): Promise<SuiteRun> =>
  (await h.container.infra.suiteRuns.getSuiteRun(id)) as SuiteRun;
const items = (h: Harness, id: string) => h.container.infra.suiteRuns.listItems(id);
const itemStatuses = async (h: Harness, id: string) =>
  (await items(h, id)).map((item) => item.status);

/** Runs the worker until the Suite Run is final, asserting the concurrency invariant each step. */
const drain = async (h: Harness, id: string, limit?: number, maxSteps = 200) => {
  for (let step = 0; step < maxSteps; step += 1) {
    const suite = await suiteOf(h, id);
    if (['Succeeded', 'Failed', 'Cancelled'].includes(suite.status)) return suite;
    if (limit !== undefined) {
      expect(activeSuiteItemCount(await counts(h, id))).toBeLessThanOrEqual(limit);
    }
    await h.container.loop.runOnce();
    if (suite.status === 'WaitingForBreakpoint') return suiteOf(h, id);
  }
  throw new Error('The Suite Run did not finish.');
};

const resumePaused = async (h: Harness, runId: string) => {
  const pause = await h.container.infra.pauses.getActivePause(runId);
  return h.container.infra.pauses.resumeRun({
    runId,
    at: AT,
    expectedGeneration: pause?.continuationGeneration,
  });
};

describe('Suite Run planning and snapshots', () => {
  it('snapshots the Suite, Test and Test Data versions and the Environment', async () => {
    const h = await createHarness();
    const plan = await submitSuite(h, [
      { id: 'test-a', nodes: [fast('a')] },
      { id: 'test-b', nodes: [fast('b')], version: 4 },
    ]);
    const stored = await suiteOf(h, plan.suiteRun.id);
    expect(stored).toMatchObject({
      status: 'Queued',
      suite: { id: 'suite-1', version: 1 },
      maxConcurrency: 1,
    });
    expect(stored.snapshots.tests.map((t) => [t.id, t.version])).toEqual([
      ['test-a', 1],
      ['test-b', 4],
    ]);
    expect(stored.snapshots.testData).toHaveLength(1);
    expect(stored.snapshots.environment.id).toBe('local-test');
    expect((await items(h, plan.suiteRun.id)).map((i) => [i.position, i.test, i.status])).toEqual([
      [0, { id: 'test-a', version: 1 }, 'Pending'],
      [1, { id: 'test-b', version: 4 }, 'Pending'],
    ]);
  });

  it('grants the requested concurrency only up to the Environment limit (default 1)', async () => {
    const h = await createHarness();
    const specs = [{ id: 'test-a', nodes: [fast('a')] }];
    expect((await submitSuite(h, specs, { concurrency: 5 })).suiteRun.maxConcurrency).toBe(1);
    expect(
      (await submitSuite(h, specs, { concurrency: 5, envLimit: 2 })).suiteRun.maxConcurrency,
    ).toBe(2);
    expect(
      (await submitSuite(h, specs, { concurrency: 2, envLimit: 4 })).suiteRun.maxConcurrency,
    ).toBe(2);
  });

  it('rejects unknown references and oversized Suites', async () => {
    const h = await createHarness();
    await expect(
      submitSuite(h, [{ id: 'test-a', nodes: [fast('a')] }], {
        env: { limits: { maxSuiteSize: 0 } },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_TARGET_POLICY' });
    expect(() =>
      buildSuiteRunPlan({
        suite: {
          schemaVersion: 1,
          id: 's',
          version: 1,
          name: 's',
          tags: [],
          metadata: meta,
          items: [{ testId: 'missing', dataSetId: 'data-1' }],
        },
        tests: [],
        testData: [dataDef('data-1')],
        environment: environment(),
        requestedBy: 't',
        requestedAt: AT,
        newId,
      }),
    ).toThrow('was not found');
  });

  it('builds child Runs only from the snapshot, so later edits never reach them', async () => {
    const h = await createHarness();
    const plan = await submitSuite(h, [{ id: 'test-a', nodes: [fast('a')] }]);
    // Even if the live Test changed, the child uses the stored version.
    await h.container.scheduler.tick();
    const [item] = await items(h, plan.suiteRun.id);
    const child = await h.container.infra.runs.getRun(item!.runId!);
    expect(child?.snapshots.test).toEqual(plan.suiteRun.snapshots.tests[0]);
    expect(child?.snapshots.environment).toEqual(plan.suiteRun.snapshots.environment);
    expect(child).toMatchObject({
      kind: 'test',
      test: { id: 'test-a', version: 1 },
      testData: { id: 'data-1', version: 1 },
      status: 'Queued',
    });
  });
});

describe('ordered execution (default concurrency 1)', () => {
  it('dispatches one child at a time, in Suite order', async () => {
    const h = await createHarness();
    const plan = await submitSuite(h, [
      { id: 'test-a', nodes: [fast('a')] },
      { id: 'test-b', nodes: [fast('b')] },
      { id: 'test-c', nodes: [fast('c')] },
    ]);
    const id = plan.suiteRun.id;

    await h.container.scheduler.tick();
    expect(await itemStatuses(h, id)).toEqual(['Queued', 'Pending', 'Pending']);
    await h.container.scheduler.tick();
    expect(await itemStatuses(h, id)).toEqual(['Queued', 'Pending', 'Pending']); // idempotent

    const final = await drain(h, id, 1);
    expect(final.status).toBe('Succeeded');
    expect(await itemStatuses(h, id)).toEqual(['Succeeded', 'Succeeded', 'Succeeded']);

    // Children were created and ran in order: Run ids follow position, finishing one before the next.
    const children = await Promise.all(
      (await items(h, id)).map((item) => h.container.infra.runs.getRun(item.runId!)),
    );
    const started = children.map((run) => Date.parse(run!.startedAt!));
    expect(started).toEqual([...started].sort((a, b) => a - b));
    const finished = children.map((run) => Date.parse(run!.finishedAt!));
    started
      .slice(1)
      .forEach((start, index) => expect(start).toBeGreaterThanOrEqual(finished[index]!));
    expect((await suiteOf(h, id)).startedAt).toBeDefined();
    expect((await suiteOf(h, id)).finishedAt).toBeDefined();
  });

  it('reports ordered child outcomes and keeps going after a failure', async () => {
    const h = await createHarness();
    const plan = await submitSuite(h, [
      { id: 'test-a', nodes: [fast('a')] },
      { id: 'test-b', nodes: [failing('b')] },
      { id: 'test-c', nodes: [fast('c')] },
    ]);
    const final = await drain(h, plan.suiteRun.id, 1);
    expect(final.status).toBe('Failed');
    expect(await itemStatuses(h, plan.suiteRun.id)).toEqual(['Succeeded', 'Failed', 'Succeeded']);
    expect(await counts(h, plan.suiteRun.id)).toMatchObject({
      total: 3,
      Succeeded: 2,
      Failed: 1,
      Pending: 0,
    });
  });

  it('publishes suiteRun.updated events ending in the final status', async () => {
    const h = await createHarness();
    const plan = await submitSuite(h, [
      { id: 'test-a', nodes: [fast('a')] },
      { id: 'test-b', nodes: [fast('b')] },
    ]);
    await drain(h, plan.suiteRun.id, 1);
    const events = await h.container.infra.events.listSuiteSince(plan.suiteRun.id);
    expect(events.length).toBeGreaterThan(2);
    expect(events.every((e) => e.type === 'suiteRun.updated')).toBe(true);
    expect(events[0]?.data.status).toBe('Queued');
    expect(events.at(-1)?.data).toMatchObject({
      status: 'Succeeded',
      counts: { total: 2, Succeeded: 2, Pending: 0 },
    });
    const seqs = events.map((e) => e.seq!);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });
});

describe('bounded concurrency', () => {
  it('never exceeds maxConcurrency while draining', async () => {
    const h = await createHarness();
    const specs = ['a', 'b', 'c', 'd', 'e'].map((x) => ({ id: `test-${x}`, nodes: [fast(x)] }));
    const plan = await submitSuite(h, specs, { concurrency: 2, envLimit: 2 });
    const id = plan.suiteRun.id;

    await h.container.scheduler.tick();
    expect(await itemStatuses(h, id)).toEqual([
      'Queued',
      'Queued',
      'Pending',
      'Pending',
      'Pending',
    ]);
    await h.container.scheduler.tick();
    expect(activeSuiteItemCount(await counts(h, id))).toBe(2);

    const final = await drain(h, id, 2);
    expect(final.status).toBe('Succeeded');
    expect(final.maxConcurrency).toBe(2);
  });

  it('does not exceed the limit after a restart, from any scheduler instance', async () => {
    const h = await createHarness();
    const specs = ['a', 'b', 'c', 'd'].map((x) => ({ id: `test-${x}`, nodes: [fast(x)] }));
    const plan = await submitSuite(h, specs, { concurrency: 2, envLimit: 2 });
    const id = plan.suiteRun.id;
    await h.container.scheduler.tick();
    expect(await itemStatuses(h, id)).toEqual(['Queued', 'Queued', 'Pending', 'Pending']);

    // A freshly started worker process (no memory of the first) shares the same database.
    const restarted = h.second('worker-b');
    expect(await restarted.scheduler.tick()).toBe(0);
    expect(await restarted.scheduler.tick()).toBe(0);
    expect(await itemStatuses(h, id)).toEqual(['Queued', 'Queued', 'Pending', 'Pending']);
    const children = h.container.infra.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as {
      n: number;
    };
    expect(children.n).toBe(2);

    // Both instances running at once still respect the limit and never duplicate a child.
    await Promise.all([h.container.scheduler.tick(), restarted.scheduler.tick()]);
    expect(
      (h.container.infra.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n,
    ).toBe(2);
  });

  it('frees a slot as soon as a child finishes', async () => {
    const h = await createHarness();
    const specs = ['a', 'b', 'c'].map((x) => ({ id: `test-${x}`, nodes: [fast(x)] }));
    const plan = await submitSuite(h, specs, { concurrency: 2, envLimit: 2 });
    const id = plan.suiteRun.id;
    await h.container.scheduler.tick();
    await h.container.loop.runOnce(); // runs the first child
    await h.container.scheduler.tick(); // observes it finish and refills the slot
    // Children created in the same millisecond may be claimed in either order, so check the shape
    // rather than which of the first two ran: one finished, and the third took the freed slot.
    expect(await counts(h, id)).toMatchObject({ Succeeded: 1, Queued: 2, Pending: 0 });
    expect((await items(h, id))[2]?.status).toBe('Queued');
    expect(activeSuiteItemCount(await counts(h, id))).toBe(2);
  });
});

describe('breakpoints inside a Suite', () => {
  it('holds the slot of a paused child and reports WaitingForBreakpoint at the limit', async () => {
    const h = await createHarness();
    const plan = await submitSuite(h, [
      { id: 'test-a', nodes: withBreakpoint('a') },
      { id: 'test-b', nodes: [fast('b')] },
    ]);
    const id = plan.suiteRun.id;

    await h.container.loop.runOnce(); // dispatch child A and run it into its Breakpoint
    await h.container.scheduler.tick();
    expect(await itemStatuses(h, id)).toEqual(['Paused', 'Pending']);
    expect((await suiteOf(h, id)).status).toBe('WaitingForBreakpoint');

    // The paused child keeps its slot: nothing else is started, however often we look.
    for (let i = 0; i < 3; i += 1) {
      expect(await h.container.loop.runOnce()).toBe(false);
      await h.container.scheduler.tick();
    }
    expect(await itemStatuses(h, id)).toEqual(['Paused', 'Pending']);

    const [first] = await items(h, id);
    expect(await resumePaused(h, first!.runId!)).toMatchObject({ outcome: 'applied' });
    await h.container.scheduler.tick();
    expect((await suiteOf(h, id)).status).toBe('Running');

    const final = await drain(h, id, 1);
    expect(final.status).toBe('Succeeded');
    expect(await itemStatuses(h, id)).toEqual(['Succeeded', 'Succeeded']);
  });

  it('lets other children run while one is paused when the limit allows it', async () => {
    const h = await createHarness();
    const plan = await submitSuite(
      h,
      [
        { id: 'test-a', nodes: withBreakpoint('a') },
        { id: 'test-b', nodes: [fast('b')] },
        { id: 'test-c', nodes: [fast('c')] },
      ],
      { concurrency: 2, envLimit: 2 },
    );
    const id = plan.suiteRun.id;
    for (let i = 0; i < 4; i += 1) await h.container.loop.runOnce();
    await h.container.scheduler.tick();

    expect(await itemStatuses(h, id)).toEqual(['Paused', 'Succeeded', 'Succeeded']);
    // Only the paused child remains active, so the parent is waiting on its Breakpoint.
    expect((await suiteOf(h, id)).status).toBe('WaitingForBreakpoint');
    expect(activeSuiteItemCount(await counts(h, id))).toBe(1);
  });

  it('keeps the paused child state across a worker restart', async () => {
    const h = await createHarness();
    const plan = await submitSuite(h, [
      { id: 'test-a', nodes: withBreakpoint('a') },
      { id: 'test-b', nodes: [fast('b')] },
    ]);
    await h.container.loop.runOnce();
    await h.container.scheduler.tick();

    const restarted = h.second('worker-b');
    expect(await restarted.scheduler.tick()).toBe(0);
    expect(await restarted.loop.runOnce()).toBe(false);
    expect((await suiteOf(h, plan.suiteRun.id)).status).toBe('WaitingForBreakpoint');
    expect(await itemStatuses(h, plan.suiteRun.id)).toEqual(['Paused', 'Pending']);
  });
});

describe('Suite Run cancellation', () => {
  it('cancels a Suite Run before anything was dispatched', async () => {
    const h = await createHarness();
    const plan = await submitSuite(h, [
      { id: 'test-a', nodes: [fast('a')] },
      { id: 'test-b', nodes: [fast('b')] },
    ]);
    const result = await h.container.infra.suiteCommands.requestCancel({
      suiteRunId: plan.suiteRun.id,
    });
    expect(result.outcome).toBe('applied');
    expect((await suiteOf(h, plan.suiteRun.id)).status).toBe('Cancelled');
    expect(await itemStatuses(h, plan.suiteRun.id)).toEqual(['Skipped', 'Skipped']);
    expect(await h.container.loop.runOnce()).toBe(false);
    expect(
      await h.container.infra.db.prepare('SELECT COUNT(*) AS n FROM runs').get(),
    ).toMatchObject({
      n: 0,
    });
  });

  it('skips undispatched children and cancels queued ones', async () => {
    const h = await createHarness();
    const plan = await submitSuite(
      h,
      ['a', 'b', 'c', 'd'].map((x) => ({ id: `test-${x}`, nodes: [fast(x)] })),
      { concurrency: 2, envLimit: 2 },
    );
    const id = plan.suiteRun.id;
    await h.container.scheduler.tick();

    await h.container.infra.suiteCommands.requestCancel({ suiteRunId: id });
    expect(await itemStatuses(h, id)).toEqual(['Cancelled', 'Cancelled', 'Skipped', 'Skipped']);
    expect((await suiteOf(h, id)).status).toBe('Cancelled');
    expect(await h.container.loop.runOnce()).toBe(false);
    expect((await suiteOf(h, id)).finishedAt).toBeDefined();
    expect((await suiteOf(h, id)).cancelRequestedAt).toBeDefined();
  });

  it('cancels a paused child directly and its successor never runs', async () => {
    const h = await createHarness();
    const plan = await submitSuite(h, [
      { id: 'test-a', nodes: withBreakpoint('a') },
      { id: 'test-b', nodes: [fast('b')] },
    ]);
    const id = plan.suiteRun.id;
    await h.container.loop.runOnce();
    await h.container.scheduler.tick();
    expect((await suiteOf(h, id)).status).toBe('WaitingForBreakpoint');
    const [first] = await items(h, id);

    expect(await h.container.infra.suiteCommands.requestCancel({ suiteRunId: id })).toMatchObject({
      outcome: 'applied',
    });
    expect((await suiteOf(h, id)).status).toBe('Cancelled');
    expect(await itemStatuses(h, id)).toEqual(['Cancelled', 'Skipped']);

    const steps = await stepRuns(h.container, first!.runId!);
    expect(steps.find((s) => s.nodeId === 'a-inspect')?.status).toBe('Cancelled');
    expect(steps.some((s) => s.nodeId === 'a-after')).toBe(false);
    expect(await h.container.loop.runOnce()).toBe(false);
    // A repeated cancel is a no-op, and resuming the cancelled child is refused.
    expect((await h.container.infra.suiteCommands.requestCancel({ suiteRunId: id })).outcome).toBe(
      'noop',
    );
    expect(await resumePaused(h, first!.runId!)).toMatchObject({ outcome: 'rejected' });
  });

  it('asks a running child to stop and finishes once it has', async () => {
    const h = await createHarness();
    const plan = await submitSuite(h, [
      { id: 'test-a', nodes: [fast('a')] },
      { id: 'test-b', nodes: [fast('b')] },
    ]);
    const id = plan.suiteRun.id;
    await h.container.scheduler.tick();
    const job = (await h.container.infra.jobs.claim({ workerId: 'worker-a', leaseMs: 30_000 }))!;
    const [first] = await items(h, id);
    await h.container.infra.runs.transitionRun(first!.runId!, {
      from: 'Queued',
      to: 'Running',
      at: AT,
    });

    await h.container.infra.suiteCommands.requestCancel({ suiteRunId: id });
    expect(await itemStatuses(h, id)).toEqual(['Cancelling', 'Skipped']);
    expect((await suiteOf(h, id)).status).toBe('Cancelling');

    // The worker owning the child sees the cancellation and closes it.
    expect(await h.container.executor.execute(job, new AbortController().signal)).toEqual({
      kind: 'complete',
    });
    await h.container.scheduler.tick();
    expect(await itemStatuses(h, id)).toEqual(['Cancelled', 'Skipped']);
    expect((await suiteOf(h, id)).status).toBe('Cancelled');
  });

  it('reports a missing or finished Suite Run', async () => {
    const h = await createHarness();
    expect(await h.container.infra.suiteCommands.requestCancel({ suiteRunId: 'nope' })).toEqual({
      outcome: 'rejected',
    });
    const plan = await submitSuite(h, [{ id: 'test-a', nodes: [fast('a')] }]);
    await drain(h, plan.suiteRun.id, 1);
    expect(
      (await h.container.infra.suiteCommands.requestCancel({ suiteRunId: plan.suiteRun.id }))
        .outcome,
    ).toBe('rejected');
  });
});

describe('rerun', () => {
  it('creates a new Suite Run from the stored snapshots', async () => {
    const h = await createHarness();
    const first = await submitSuite(h, [
      { id: 'test-a', nodes: [fast('a')] },
      { id: 'test-b', nodes: [failing('b')] },
    ]);
    const original = await drain(h, first.suiteRun.id, 1);
    expect(original.status).toBe('Failed');

    const plan = planSuiteRerun(original, { requestedBy: 'tester', requestedAt: AT, newId });
    expect(plan.suiteRun).toMatchObject({
      rerunOfSuiteRunId: original.id,
      status: 'Queued',
      maxConcurrency: original.maxConcurrency,
    });
    expect(plan.suiteRun.id).not.toBe(original.id);
    expect(plan.suiteRun.snapshots.tests).toEqual(original.snapshots.tests);
    expect(plan.items.map((i) => [i.position, i.test, i.status])).toEqual(
      (await items(h, original.id)).map((i) => [i.position, i.test, 'Pending']),
    );
    expect(new Set([...plan.items.map((i) => i.id), plan.suiteRun.id]).size).toBe(3);

    await h.container.infra.suiteCommands.submit(plan);
    const rerun = await drain(h, plan.suiteRun.id, 1);
    expect(rerun.status).toBe('Failed');
    expect(await itemStatuses(h, plan.suiteRun.id)).toEqual(['Succeeded', 'Failed']);
    // The original is untouched.
    expect((await suiteOf(h, original.id)).status).toBe('Failed');
    expect(await itemStatuses(h, original.id)).toEqual(['Succeeded', 'Failed']);
    expect(
      (h.container.infra.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n,
    ).toBe(4);
  });

  it('keeps open-ended versions pinned to what the original resolved', async () => {
    const h = await createHarness();
    const first = await submitSuite(h, [{ id: 'test-a', nodes: [fast('a')], version: 3 }]);
    const original = await suiteOf(h, first.suiteRun.id);
    const plan = planSuiteRerun(original, { requestedBy: 't', requestedAt: AT, newId });
    expect(plan.items[0]?.test).toEqual({ id: 'test-a', version: 3 });
  });
});

describe('clock-independent recovery of the parent', () => {
  it('finishes a Suite Run whose scheduler was restarted between children', async () => {
    const clock = new FakeClock();
    const h = await createHarness({ clock });
    const plan = await submitSuite(h, [
      { id: 'test-a', nodes: [fast('a')] },
      { id: 'test-b', nodes: [fast('b')] },
    ]);
    await h.container.loop.runOnce(); // dispatches A and runs it
    const restarted = h.second('worker-b');
    const final = await drain({ ...h, container: restarted }, plan.suiteRun.id, 1);
    expect(final.status).toBe('Succeeded');
    expect(await itemStatuses(h, plan.suiteRun.id)).toEqual(['Succeeded', 'Succeeded']);
  });
});
