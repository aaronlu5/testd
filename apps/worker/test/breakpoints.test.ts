import { afterEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '@test-platform/contracts';
import { newId } from '@test-platform/infrastructure-local';
import {
  FakeClock,
  SECRET,
  cleanupAll,
  createHarness,
  eventsOf,
  makeRun,
  node,
  runStatuses,
  stepRuns,
  submit,
  type Harness,
} from './helpers.js';

afterEach(cleanupAll);

const NOW = '2026-01-01T00:10:00.000Z';

/** Delay -> Breakpoint -> Assert, where the Assert input carries a secret and a computed value. */
const flow = (breakpoint: JsonObject = { enabled: true, message: 'Review it.' }) => [
  node('shape', 'transform.json', {
    input: { id: 'ORD-1', secret: SECRET },
    mapping: { id: '$.id' },
  }),
  node('inspect', 'breakpoint', breakpoint),
  node('verify', 'assert', {
    actual: '{{steps.shape.output.id}}',
    operator: 'equals',
    expected: 'ORD-1',
    message: `token=${SECRET}`,
  }),
];

const pauseRun = async (
  h: Harness,
  nodes = flow(),
  options: Parameters<typeof makeRun>[1] = {},
) => {
  const run = makeRun(nodes, options);
  await submit(h.container, run);
  expect(await h.container.loop.runOnce()).toBe(true);
  return run;
};

const resume = (h: Harness, runId: string, expectedGeneration: number | undefined = 0) =>
  h.container.infra.pauses.resumeRun({ runId, at: NOW, expectedGeneration });

const statusOf = async (h: Harness, runId: string) =>
  (await h.container.infra.runs.getRun(runId))?.status;

describe('enabled Breakpoint', () => {
  it('pauses with a persisted, sanitized pause record and releases the job', async () => {
    const h = await createHarness();
    const run = await pauseRun(h);

    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({
      status: 'Paused',
      pausedAt: expect.any(String),
    });
    const steps = await stepRuns(h.container, run.id);
    expect(steps.map((s) => [s.nodeId, s.status])).toEqual([
      ['inspect', 'Paused'],
      ['shape', 'Succeeded'],
    ]); // the successor has not been started

    const pause = await h.container.infra.pauses.getActivePause(run.id);
    expect(pause).toMatchObject({
      breakpointNodeId: 'inspect',
      message: 'Review it.',
      nextNodeId: 'verify',
      nextNodeName: 'verify',
      nextNodeType: 'assert',
      continuationGeneration: 0,
    });
    // The preview is the resolved successor input, with the secret masked.
    expect(pause?.nextResolvedInputPreview).toMatchObject({
      actual: 'ORD-1',
      operator: 'equals',
      expected: 'ORD-1',
    });
    expect(JSON.stringify(pause)).not.toContain(SECRET);
    expect(JSON.stringify(pause?.nextResolvedInputPreview)).toContain('REDACTED');

    // The lease is released and nothing is held by this worker.
    const job = await h.container.infra.db
      .prepare('SELECT status, lease_owner FROM jobs WHERE run_id = ?')
      .get(run.id);
    expect(job).toMatchObject({ status: 'completed', lease_owner: null });
    expect(h.container.loop.activeJobId).toBeUndefined();
    expect(await h.container.loop.runOnce()).toBe(false);

    const events = await eventsOf(h.container, run.id);
    expect(runStatuses(events)).toEqual(['Queued', 'Running', 'Paused']);
    expect(events.map((e) => e.type)).toContain('run.paused');
    // A pause is not final, so no terminal event ends the stream.
    expect(events.at(-1)).toMatchObject({ type: 'run.paused' });
  });

  it('keeps every persisted record free of secret values', async () => {
    const h = await createHarness();
    const run = await pauseRun(h);
    await resume(h, run.id);
    await h.container.loop.runOnce();

    const db = h.container.infra.db;
    for (const table of ['step_runs', 'run_pauses', 'run_events', 'audit_events', 'jobs']) {
      const dump = JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all());
      expect(dump, table).not.toContain(SECRET);
    }
    expect(h.logs.join('\n')).not.toContain(SECRET);
  });

  it('resumes and runs the successor exactly once, preserving the snapshot', async () => {
    const h = await createHarness();
    const run = await pauseRun(h);
    const before = JSON.stringify((await h.container.infra.runs.getRun(run.id))?.snapshots);

    const resumed = await resume(h, run.id);
    expect(resumed.outcome).toBe('applied');
    expect(await statusOf(h, run.id)).toBe('Queued'); // same Run, not a new one
    expect(await h.container.loop.runOnce()).toBe(true);

    const finished = await h.container.infra.runs.getRun(run.id);
    expect(finished).toMatchObject({ status: 'Succeeded', continuationGeneration: 1 });
    expect(JSON.stringify(finished?.snapshots)).toBe(before);

    const steps = await stepRuns(h.container, run.id);
    expect(steps.map((s) => [s.nodeId, s.attempt, s.status])).toEqual([
      ['inspect', 1, 'Succeeded'],
      ['shape', 1, 'Succeeded'],
      ['verify', 1, 'Succeeded'],
    ]);
    expect(steps.find((s) => s.nodeId === 'inspect')?.outputPreview).toEqual({ enabled: true });

    const events = await eventsOf(h.container, run.id);
    expect(runStatuses(events)).toEqual([
      'Queued',
      'Running',
      'Paused',
      'Queued',
      'Running',
      'Succeeded',
    ]);
    expect(events.map((e) => e.type)).toContain('run.resumed');
    expect(events.at(-1)).toMatchObject({ type: 'run.status', data: { status: 'Succeeded' } });
  });

  it('does not queue duplicate continuations for repeated resume requests', async () => {
    const h = await createHarness();
    const run = await pauseRun(h);

    const results = await Promise.all([resume(h, run.id), resume(h, run.id), resume(h, run.id)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['applied', 'noop', 'noop']);
    expect(await h.container.loop.runOnce()).toBe(true);
    expect(await h.container.loop.runOnce()).toBe(false); // no second job
    expect(await resume(h, run.id)).toMatchObject({ outcome: 'noop' }); // late click after completion

    const verifies = (await stepRuns(h.container, run.id)).filter((s) => s.nodeId === 'verify');
    expect(verifies).toHaveLength(1);
    expect(await statusOf(h, run.id)).toBe('Succeeded');
  });

  it('supports several Breakpoints, each with its own generation', async () => {
    const h = await createHarness();
    const run = await pauseRun(h, [
      node('first', 'breakpoint', { enabled: true }),
      node('mid', 'transform.json', { input: { n: 1 }, mapping: { n: '$.n' } }),
      node('second', 'breakpoint', { enabled: true, message: 'Again' }),
      node('last', 'assert', { actual: 1, operator: 'equals', expected: 1 }),
    ]);
    expect(await h.container.infra.pauses.getActivePause(run.id)).toMatchObject({
      breakpointNodeId: 'first',
      nextNodeId: 'mid',
    });

    await resume(h, run.id, 0);
    await h.container.loop.runOnce();
    expect(await statusOf(h, run.id)).toBe('Paused');
    expect(await h.container.infra.pauses.getActivePause(run.id)).toMatchObject({
      breakpointNodeId: 'second',
      continuationGeneration: 1,
      message: 'Again',
    });

    // The first pause's generation is now stale.
    expect(await resume(h, run.id, 0)).toMatchObject({
      outcome: 'rejected',
      reason: 'stale-generation',
    });
    await resume(h, run.id, 1);
    await h.container.loop.runOnce();
    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({
      status: 'Succeeded',
      continuationGeneration: 2,
    });
    expect((await stepRuns(h.container, run.id)).map((s) => [s.nodeId, s.status])).toEqual([
      ['first', 'Succeeded'],
      ['last', 'Succeeded'],
      ['mid', 'Succeeded'],
      ['second', 'Succeeded'],
    ]);
  });
});

describe('disabled Breakpoint', () => {
  it('records Skipped with reason "disabled" and continues without pausing', async () => {
    const h = await createHarness();
    const run = makeRun(flow({ enabled: false }));
    await submit(h.container, run);
    await h.container.loop.runOnce();

    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({ status: 'Succeeded' });
    const skipped = (await stepRuns(h.container, run.id)).find((s) => s.nodeId === 'inspect');
    expect(skipped).toMatchObject({
      status: 'Skipped',
      outputPreview: { enabled: false, skipped: true, reason: 'disabled' },
    });
    expect(skipped?.logs[0]?.message).toContain('disabled');
    expect(await h.container.infra.pauses.listPauses(run.id)).toEqual([]);
    expect(runStatuses(await eventsOf(h.container, run.id))).toEqual([
      'Queued',
      'Running',
      'Succeeded',
    ]);
  });

  it('lets later Steps read the Skipped output deterministically', async () => {
    const h = await createHarness();
    const run = makeRun([
      node('inspect', 'breakpoint', { enabled: false }),
      node('verify', 'assert', {
        actual: '{{steps.inspect.output.reason}}',
        operator: 'equals',
        expected: 'disabled',
      }),
    ]);
    await submit(h.container, run);
    await h.container.loop.runOnce();
    expect(await statusOf(h, run.id)).toBe('Succeeded');
  });
});

describe('end-of-flow Breakpoint', () => {
  it('pauses with no successor and resumes to completion', async () => {
    const h = await createHarness();
    const run = await pauseRun(h, [
      node('shape', 'transform.json', { input: { a: 1 }, mapping: { a: '$.a' } }),
      node('end', 'breakpoint', { enabled: true }),
    ]);
    const pause = await h.container.infra.pauses.getActivePause(run.id);
    expect(pause).toMatchObject({ breakpointNodeId: 'end', nextNodeId: null });
    expect(pause?.nextResolvedInputPreview).toBeUndefined();
    expect(pause?.nextNodeName).toBeUndefined();

    await resume(h, run.id);
    await h.container.loop.runOnce();
    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({ status: 'Succeeded' });
    expect((await stepRuns(h.container, run.id)).find((s) => s.nodeId === 'end')?.status).toBe(
      'Succeeded',
    );
  });
});

describe('cancelling a paused Run', () => {
  it('cancels the Run and the Breakpoint attempt, and the successor never executes', async () => {
    const h = await createHarness();
    const run = await pauseRun(h);

    const cancelled = await h.container.infra.commands.requestCancel({ runId: run.id, at: NOW });
    expect(cancelled.outcome).toBe('applied');
    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({ status: 'Cancelled' });

    const steps = await stepRuns(h.container, run.id);
    expect(steps.find((s) => s.nodeId === 'inspect')?.status).toBe('Cancelled');
    expect(steps.some((s) => s.nodeId === 'verify')).toBe(false);

    // Nothing is queued, a resume is refused, and no worker can pick the Run up.
    expect(await h.container.loop.runOnce()).toBe(false);
    expect(await resume(h, run.id)).toMatchObject({ outcome: 'rejected', reason: 'not-paused' });
    expect(await h.container.loop.runOnce()).toBe(false);
    expect((await stepRuns(h.container, run.id)).some((s) => s.nodeId === 'verify')).toBe(false);

    const events = await eventsOf(h.container, run.id);
    expect(events.at(-1)).toMatchObject({ type: 'run.cancelled', data: { whilePaused: true } });
    expect(runStatuses(events).at(-1)).toBe('Cancelled');
    // A repeated cancel is a no-op.
    expect(
      (await h.container.infra.commands.requestCancel({ runId: run.id, at: NOW })).outcome,
    ).toBe('noop');
  });

  it('cancels a resumed Run that no worker has claimed yet', async () => {
    const h = await createHarness();
    const run = await pauseRun(h);
    await resume(h, run.id);
    await h.container.infra.commands.requestCancel({ runId: run.id, at: NOW });

    expect(await statusOf(h, run.id)).toBe('Cancelled');
    expect(await h.container.loop.runOnce()).toBe(false);
    const steps = await stepRuns(h.container, run.id);
    expect(steps.find((s) => s.nodeId === 'inspect')?.status).toBe('Cancelled');
    expect(steps.some((s) => s.nodeId === 'verify')).toBe(false);
  });

  it('stops a continuation that is cancelled mid-flight without running the successor', async () => {
    const h = await createHarness();
    const run = await pauseRun(h);
    await resume(h, run.id);
    // A worker claimed the continuation and moved the Run to Running, then a cancel arrived.
    const job = await h.container.infra.jobs.claim({ workerId: 'worker-a', leaseMs: 30_000 });
    await h.container.infra.runs.transitionRun(run.id, { from: 'Queued', to: 'Running', at: NOW });
    await h.container.infra.commands.requestCancel({ runId: run.id, at: NOW });
    expect(await statusOf(h, run.id)).toBe('Cancelling');

    const disposition = await h.container.executor.execute(job!, new AbortController().signal);
    expect(disposition).toEqual({ kind: 'complete' });
    expect(await statusOf(h, run.id)).toBe('Cancelled');
    const steps = await stepRuns(h.container, run.id);
    expect(steps.find((s) => s.nodeId === 'inspect')?.status).toBe('Cancelled');
    expect(steps.some((s) => s.nodeId === 'verify')).toBe(false);
  });
});

describe('continuation safety', () => {
  it('fails with EXECUTION_BREAKPOINT_CONTEXT_CHANGED when the successor input differs', async () => {
    const h = await createHarness();
    const run = await pauseRun(h);
    // Persisted evidence changes while the Run is paused.
    h.container.infra.db
      .prepare(
        'UPDATE step_runs SET output_preview = \'{"id":"ORD-2"}\' WHERE run_id = ? AND node_id = \'shape\'',
      )
      .run(run.id);

    await resume(h, run.id);
    await h.container.loop.runOnce();

    const finished = await h.container.infra.runs.getRun(run.id);
    expect(finished).toMatchObject({
      status: 'Failed',
      error: { code: 'EXECUTION_BREAKPOINT_CONTEXT_CHANGED' },
    });
    const verify = (await stepRuns(h.container, run.id)).find((s) => s.nodeId === 'verify');
    expect(verify).toMatchObject({
      status: 'Failed',
      error: { code: 'EXECUTION_BREAKPOINT_CONTEXT_CHANGED' },
    });
    expect(JSON.stringify(finished?.error)).not.toContain(SECRET);
  });

  it('compares masked content, so a rotated secret does not trigger a mismatch', async () => {
    const h = await createHarness();
    const run = await pauseRun(h);
    await resume(h, run.id);
    await h.container.loop.runOnce();
    expect(await statusOf(h, run.id)).toBe('Succeeded');
  });

  it('keeps large inputs inspectable through an artifact and still verifies them', async () => {
    const h = await createHarness({
      env: { TEST_PLATFORM_WORKER_PAYLOAD_CAPTURE_BYTES: '512' },
    });
    const big = 'x'.repeat(4000);
    const run = await pauseRun(h, [
      node('shape', 'transform.json', { input: { v: big }, mapping: { v: '$.v' } }),
      node('inspect', 'breakpoint', { enabled: true }),
      node('verify', 'assert', {
        actual: '{{steps.shape.output.v}}',
        operator: 'equals',
        expected: big,
      }),
    ]);
    const pause = await h.container.infra.pauses.getActivePause(run.id);
    expect(pause?.nextResolvedInputPreview).toMatchObject({ $truncated: true });
    expect(pause?.nextInputArtifactId).toBeDefined();
    const artifact = await h.container.infra.artifacts.read(pause!.nextInputArtifactId!);
    expect(Buffer.from(artifact!.content).toString()).toContain(big.slice(0, 100));

    await resume(h, run.id);
    await h.container.loop.runOnce();
    expect(await statusOf(h, run.id)).toBe('Succeeded');
  });

  it('fails clearly when the paused attempt does not belong to the resumed generation', async () => {
    const h = await createHarness();
    const run = await pauseRun(h);
    // A queued job for a Run that was never resumed (for example inserted by hand).
    h.container.infra.db.prepare("UPDATE runs SET status = 'Queued' WHERE id = ?").run(run.id);
    await h.container.infra.jobs.enqueue({ runId: run.id });
    await h.container.loop.runOnce();
    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({
      status: 'Failed',
      error: { code: 'EXECUTION_STALE_CONTINUATION' },
    });
    expect((await stepRuns(h.container, run.id)).some((s) => s.nodeId === 'verify')).toBe(false);
  });
});

describe('worker crash and lease expiry', () => {
  const crashAfterBeginningBreakpoint = async (h: Harness, clock: FakeClock) => {
    const run = makeRun(flow());
    const { job } = await submit(h.container, run);
    await h.container.infra.jobs.claim({ workerId: 'dead-worker', leaseMs: h.config.leaseMs });
    await h.container.infra.runs.transitionRun(run.id, { from: 'Queued', to: 'Running', at: NOW });
    await h.container.infra.runs.createStepRun({
      id: newId(),
      runId: run.id,
      nodeId: 'shape',
      attempt: 1,
      status: 'Succeeded',
      outputPreview: { id: 'ORD-1' },
      logs: [],
      artifacts: [],
    });
    await h.container.infra.runs.createStepRun({
      id: newId(),
      runId: run.id,
      nodeId: 'inspect',
      attempt: 1,
      status: 'Running',
      logs: [],
      artifacts: [],
    });
    clock.advance(h.config.leaseMs + 1000);
    return { run, job };
  };

  it('recovers from a crash before the pause committed, creating exactly one pause', async () => {
    const clock = new FakeClock();
    const h = await createHarness({ clock });
    const { run, job } = await crashAfterBeginningBreakpoint(h, clock);

    expect(await h.container.loop.runOnce()).toBe(true); // reaps the lease, then re-claims the job
    expect(await statusOf(h, run.id)).toBe('Paused');
    const inspects = (await stepRuns(h.container, run.id)).filter((s) => s.nodeId === 'inspect');
    expect(inspects.map((s) => [s.attempt, s.status])).toEqual([
      [1, 'Failed'],
      [2, 'Paused'],
    ]);
    expect(await h.container.infra.pauses.listPauses(run.id)).toHaveLength(1);
    expect((await stepRuns(h.container, run.id)).some((s) => s.nodeId === 'verify')).toBe(false);
    expect(await h.container.infra.jobs.get(job.id)).toMatchObject({ status: 'completed' });
  });

  it('rejects a stale worker that tries to pause after losing its lease', async () => {
    const clock = new FakeClock();
    const h = await createHarness({ clock });
    const { run, job } = await crashAfterBeginningBreakpoint(h, clock);
    const open = (await stepRuns(h.container, run.id)).find((s) => s.nodeId === 'inspect')!;

    const result = await h.container.infra.pauses.pauseRun({
      runId: run.id,
      jobId: job.id,
      workerId: 'dead-worker',
      breakpointStepRunId: open.id,
      pause: { breakpointNodeId: 'inspect', nextNodeId: null, pausedAt: NOW },
    });
    expect(result).toEqual({ outcome: 'rejected', reason: 'lease-lost' });
    expect(await statusOf(h, run.id)).toBe('Running');
  });

  const crashDuringContinuation = async (h: Harness, markReleased: boolean) => {
    const run = await pauseRun(h);
    await resume(h, run.id);
    const claimed = await h.container.infra.jobs.claim({
      workerId: 'dead-worker',
      leaseMs: h.config.leaseMs,
    });
    await h.container.infra.runs.transitionRun(run.id, { from: 'Queued', to: 'Running', at: NOW });
    if (markReleased) {
      const bp = (await stepRuns(h.container, run.id)).find((s) => s.nodeId === 'inspect')!;
      await h.container.infra.runs.updateStepRun(
        bp.id,
        { status: 'Succeeded', outputPreview: { enabled: true } },
        'Paused',
      );
    }
    return { run, job: claimed! };
  };

  for (const markReleased of [false, true]) {
    it(`finishes the Run once after a crash during continuation (breakpoint ${markReleased ? 'already released' : 'still paused'})`, async () => {
      const clock = new FakeClock();
      const h = await createHarness({ clock });
      const { run } = await crashDuringContinuation(h, markReleased);
      clock.advance(h.config.leaseMs + 1000);

      expect(await h.container.loop.runOnce()).toBe(true);
      expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({
        status: 'Succeeded',
        continuationGeneration: 1,
      });
      const steps = await stepRuns(h.container, run.id);
      expect(steps.filter((s) => s.nodeId === 'verify')).toHaveLength(1);
      expect(steps.filter((s) => s.nodeId === 'inspect').map((s) => s.status)).toEqual([
        'Succeeded',
      ]);
      expect(await h.container.loop.runOnce()).toBe(false);
    });
  }

  it('does not start a second continuation when the resume is repeated after a crash', async () => {
    const clock = new FakeClock();
    const h = await createHarness({ clock });
    const { run } = await crashDuringContinuation(h, false);
    expect(await resume(h, run.id)).toMatchObject({ outcome: 'noop' });
    clock.advance(h.config.leaseMs + 1000);
    await h.container.loop.runOnce();
    await h.container.loop.runOnce();
    expect((await stepRuns(h.container, run.id)).filter((s) => s.nodeId === 'verify')).toHaveLength(
      1,
    );
  });

  it('closes a Run whose job ran out of attempts instead of leaving it Running', async () => {
    const clock = new FakeClock();
    const h = await createHarness({ clock });
    const run = makeRun(flow());
    const { job } = await submit(h.container, run);
    h.container.infra.db.prepare('UPDATE jobs SET max_attempts = 1 WHERE id = ?').run(job.id);
    await h.container.infra.jobs.claim({ workerId: 'dead-worker', leaseMs: h.config.leaseMs });
    await h.container.infra.runs.transitionRun(run.id, { from: 'Queued', to: 'Running', at: NOW });
    clock.advance(h.config.leaseMs + 1000);

    expect(await h.container.infra.jobs.recoverExpired()).toEqual({
      requeued: 0,
      failed: 1,
      runsFailed: 1,
    });
    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({
      status: 'Failed',
      error: { code: 'EXECUTION_LEASE' },
    });
    expect(runStatuses(await eventsOf(h.container, run.id)).at(-1)).toBe('Failed');
  });
});
