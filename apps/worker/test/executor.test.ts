import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeClock,
  SECRET,
  cleanupAll,
  createHarness,
  createTestRegistry,
  environment,
  eventsOf,
  makeRun,
  newTestState,
  node,
  runStatuses,
  stepRuns,
  submit,
  waitFor,
} from './helpers.js';

afterEach(cleanupAll);

const delay = (id: string, seconds = 0.01, execution?: Parameters<typeof node>[3]) =>
  node(id, 'delay', { durationSeconds: seconds }, execution);

describe('successful Run', () => {
  it('executes delay, transform.json and assert in order and finishes Succeeded', async () => {
    const h = await createHarness();
    const run = makeRun(
      [
        delay('wait'),
        node('shape', 'transform.json', {
          input: '{{testData.order}}',
          mapping: { id: '$.id' },
        }),
        node('verify', 'assert', {
          actual: '{{steps.shape.output.id}}',
          operator: 'equals',
          expected: '{{variables.orderId}}',
        }),
      ],
      {
        variables: { orderId: '{{testData.order.id}}' },
        data: { order: { id: 'ORD-1', customerId: 'CUS-1' } },
      },
    );
    const { job } = await submit(h.container, run);

    expect(await h.container.loop.runOnce()).toBe(true);

    const finished = await h.container.infra.runs.getRun(run.id);
    expect(finished).toMatchObject({ status: 'Succeeded' });
    expect(finished?.startedAt).toBeDefined();
    expect(finished?.finishedAt).toBeDefined();
    expect(finished?.error).toBeUndefined();

    const steps = await stepRuns(h.container, run.id);
    expect(steps.map((step) => [step.nodeId, step.attempt, step.status])).toEqual([
      ['shape', 1, 'Succeeded'],
      ['verify', 1, 'Succeeded'],
      ['wait', 1, 'Succeeded'],
    ]);
    expect(steps.find((step) => step.nodeId === 'shape')).toMatchObject({
      resolvedInput: { input: { id: 'ORD-1', customerId: 'CUS-1' }, mapping: { id: '$.id' } },
      outputPreview: { id: 'ORD-1' },
    });
    expect(steps.every((step) => step.durationMs !== undefined && step.finishedAt)).toBe(true);

    expect(await h.container.infra.jobs.get(job.id)).toMatchObject({ status: 'completed' });

    const events = await eventsOf(h.container, run.id);
    expect(runStatuses(events)).toEqual(['Queued', 'Running', 'Succeeded']);
    // The terminal Run event is the last event so the SSE stream cannot end before it.
    expect(events.at(-1)).toMatchObject({ type: 'run.status', data: { status: 'Succeeded' } });
    expect(
      events.filter((event) => event.type === 'step.status').map((event) => event.data.status),
    ).toEqual(['Running', 'Succeeded', 'Running', 'Succeeded', 'Running', 'Succeeded']);
  });

  it('resolves global variables in Test Data and Step parameters, fixed for the Run', async () => {
    const h = await createHarness();
    const run = makeRun(
      [
        delay('wait'),
        node('verify', 'assert', {
          actual: '{{variables.orderId}}',
          operator: 'equals',
          expected: 'ORD-{{global.runNumber}}-{{global.runSeed}}',
        }),
      ],
      {
        variables: { orderId: '{{testData.order.id}}' },
        data: { order: { id: 'ORD-{{global.runNumber}}-{{global.runSeed}}' } },
      },
    );
    await submit(h.container, run);
    expect(await h.container.loop.runOnce()).toBe(true);

    const finished = await h.container.infra.runs.getRun(run.id);
    expect(finished).toMatchObject({ status: 'Succeeded' });
    expect(finished?.runNumber).toBe(1);
  });

  it('completes the job without work when the Run is already final', async () => {
    const h = await createHarness();
    const run = makeRun([delay('wait')]);
    const { job } = await submit(h.container, run);
    await h.container.infra.runs.transitionRun(run.id, {
      from: 'Queued',
      to: 'Running',
      at: '2026-01-01T00:00:01.000Z',
    });
    await h.container.infra.runs.transitionRun(run.id, {
      from: 'Running',
      to: 'Succeeded',
      at: '2026-01-01T00:00:02.000Z',
    });

    await h.container.loop.runOnce();

    expect(await h.container.infra.jobs.get(job.id)).toMatchObject({ status: 'completed' });
    expect(await stepRuns(h.container, run.id)).toEqual([]);
  });

  it('does nothing when the queue is empty', async () => {
    const h = await createHarness();
    expect(await h.container.loop.runOnce()).toBe(false);
  });
});

describe('failures', () => {
  it('fails the Run on an assertion failure without running later Steps or retrying', async () => {
    const h = await createHarness();
    const run = makeRun([
      node(
        'check',
        'assert',
        { actual: 1, operator: 'equals', expected: 2 },
        {
          retry: { maxAttempts: 3, initialDelayMs: 1 },
        },
      ),
      delay('never'),
    ]);
    await submit(h.container, run);
    await h.container.loop.runOnce();

    const finished = await h.container.infra.runs.getRun(run.id);
    expect(finished).toMatchObject({
      status: 'Failed',
      error: { code: 'EXECUTION_ASSERTION_FAILED' },
    });
    expect(finished?.error?.message).toContain('check');

    const steps = await stepRuns(h.container, run.id);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      status: 'Failed',
      attempt: 1,
      error: { code: 'EXECUTION_ASSERTION_FAILED' },
    });
    expect(runStatuses(await eventsOf(h.container, run.id)).at(-1)).toBe('Failed');
  });

  it('fails a Run whose parameters cannot be resolved and records the failed Step', async () => {
    const h = await createHarness();
    const run = makeRun([
      node('check', 'assert', { actual: '{{steps.missing.output}}', operator: 'exists' }),
    ]);
    await submit(h.container, run);
    await h.container.loop.runOnce();

    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({ status: 'Failed' });
    expect(await stepRuns(h.container, run.id)).toEqual([
      expect.objectContaining({ nodeId: 'check', status: 'Failed' }),
    ]);
  });

  it('fails a Run whose variables cannot be resolved before any Step runs', async () => {
    const h = await createHarness();
    const run = makeRun([delay('wait')], { variables: { id: '{{testData.absent}}' } });
    await submit(h.container, run);
    await h.container.loop.runOnce();

    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({
      status: 'Failed',
      error: { code: 'VALIDATION_EXPRESSION' },
    });
    expect(await stepRuns(h.container, run.id)).toEqual([]);
  });

  it('fails Suite Runs, which the worker does not execute in Phase 1', async () => {
    const h = await createHarness();
    const run = { ...makeRun([delay('wait')]), kind: 'suite' as const };
    await submit(h.container, run);
    await h.container.loop.runOnce();
    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({
      status: 'Failed',
      error: { code: 'VALIDATION_REFERENCE' },
    });
  });

  it('rejects invalid resolved configuration as a non-retryable VALIDATION_SCHEMA failure', async () => {
    const h = await createHarness();
    const run = makeRun([delay('wait', -5, { retry: { maxAttempts: 3, initialDelayMs: 1 } })]);
    await submit(h.container, run);
    await h.container.loop.runOnce();

    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({
      status: 'Failed',
      error: { code: 'VALIDATION_SCHEMA' },
    });
    expect(await stepRuns(h.container, run.id)).toHaveLength(1);
  });
});

describe('retry', () => {
  it('retries retryable failures with backoff and then succeeds', async () => {
    const state = newTestState();
    state.flakyFailures = 2;
    const h = await createHarness({ registry: createTestRegistry(state) });
    const run = makeRun([
      node('call', 'flaky', {}, { retry: { maxAttempts: 3, initialDelayMs: 5, maxDelayMs: 20 } }),
    ]);
    await submit(h.container, run);
    await h.container.loop.runOnce();

    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({ status: 'Succeeded' });
    const steps = await stepRuns(h.container, run.id);
    expect(steps.map((step) => [step.attempt, step.status])).toEqual([
      [1, 'Retrying'],
      [2, 'Retrying'],
      [3, 'Succeeded'],
    ]);
    expect(steps[0]?.error).toMatchObject({ code: 'TARGET_SERVICE' });
    expect(state.flakyCalls).toBe(3);
  });

  it('fails once the attempts are exhausted', async () => {
    const state = newTestState();
    state.flakyFailures = 99;
    const h = await createHarness({ registry: createTestRegistry(state) });
    const run = makeRun([
      node('call', 'flaky', {}, { retry: { maxAttempts: 2, initialDelayMs: 1 } }),
    ]);
    await submit(h.container, run);
    await h.container.loop.runOnce();

    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({
      status: 'Failed',
      error: { code: 'TARGET_SERVICE' },
    });
    expect((await stepRuns(h.container, run.id)).map((step) => step.status)).toEqual([
      'Retrying',
      'Failed',
    ]);
  });

  it('caps attempts at the Environment limit', async () => {
    const state = newTestState();
    state.flakyFailures = 99;
    const h = await createHarness({ registry: createTestRegistry(state) });
    const run = makeRun(
      [node('call', 'flaky', {}, { retry: { maxAttempts: 10, initialDelayMs: 1 } })],
      { environment: environment({ limits: { maxRetryAttempts: 2 } }) },
    );
    await submit(h.container, run);
    await h.container.loop.runOnce();
    expect(state.flakyCalls).toBe(2);
  });

  it('does not retry Steps that do not support retry', async () => {
    const state = newTestState();
    state.flakyFailures = 99;
    const h = await createHarness({ registry: createTestRegistry(state) });
    const run = makeRun([
      node(
        'check',
        'assert',
        { actual: 1, operator: 'equals', expected: 2 },
        { retry: { maxAttempts: 5 } },
      ),
    ]);
    await submit(h.container, run);
    await h.container.loop.runOnce();
    expect(await stepRuns(h.container, run.id)).toHaveLength(1);
  });
});

describe('timeout', () => {
  it('fails a Step that exceeds its timeout with EXECUTION_TIMEOUT', async () => {
    const h = await createHarness();
    const run = makeRun([delay('slow', 30, { timeoutSeconds: 0.05 })]);
    await submit(h.container, run);
    const started = Date.now();
    await h.container.loop.runOnce();

    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({
      status: 'Failed',
      error: { code: 'EXECUTION_TIMEOUT' },
    });
    expect(await stepRuns(h.container, run.id)).toEqual([
      expect.objectContaining({
        status: 'Failed',
        error: expect.objectContaining({ code: 'EXECUTION_TIMEOUT' }),
      }),
    ]);
  });

  it('applies the smaller of the node timeout and the Environment maximum', async () => {
    const h = await createHarness();
    const run = makeRun([delay('slow', 30, { timeoutSeconds: 600 })], {
      environment: environment({ limits: { maxStepTimeoutSeconds: 0.05 } }),
    });
    await submit(h.container, run);
    await h.container.loop.runOnce();
    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({
      error: { code: 'EXECUTION_TIMEOUT' },
    });
  });

  it('retries a timed-out Step when its policy allows', async () => {
    const h = await createHarness();
    const run = makeRun([
      delay('slow', 30, { timeoutSeconds: 0.03, retry: { maxAttempts: 2, initialDelayMs: 1 } }),
    ]);
    await submit(h.container, run);
    await h.container.loop.runOnce();
    expect((await stepRuns(h.container, run.id)).map((step) => step.status)).toEqual([
      'Retrying',
      'Failed',
    ]);
  });
});

describe('cancellation', () => {
  it('never starts a Run that was cancelled while queued', async () => {
    const h = await createHarness();
    const run = makeRun([delay('wait')]);
    const { job } = await submit(h.container, run);
    await h.container.infra.commands.requestCancel({
      runId: run.id,
      at: '2026-01-01T00:00:01.000Z',
    });

    expect(await h.container.loop.runOnce()).toBe(false);
    expect(await h.container.infra.jobs.get(job.id)).toMatchObject({ status: 'cancelled' });
    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({ status: 'Cancelled' });
    expect(await stepRuns(h.container, run.id)).toEqual([]);
  });

  it('stops between Steps when cancellation was requested during a Step', async () => {
    const state = newTestState();
    const h = await createHarness({ registry: createTestRegistry(state) });
    state.onHook = async (runId) => {
      await h.container.infra.commands.requestCancel({ runId, at: new Date().toISOString() });
    };
    const run = makeRun([node('first', 'hook'), delay('second')]);
    await submit(h.container, run);
    await h.container.loop.runOnce();

    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({ status: 'Cancelled' });
    const steps = await stepRuns(h.container, run.id);
    expect(steps.map((step) => step.nodeId)).toEqual(['first']);
    const events = await eventsOf(h.container, run.id);
    expect(runStatuses(events)).toEqual(['Queued', 'Running', 'Cancelling', 'Cancelled']);
    expect(events.at(-1)).toMatchObject({ data: { status: 'Cancelled' } });
  });

  it('interrupts a running delay', async () => {
    const h = await createHarness();
    const run = makeRun([delay('long', 60)]);
    const { job } = await submit(h.container, run);
    const working = h.container.loop.runOnce();

    await waitFor(async () => (await stepRuns(h.container, run.id))[0]?.status === 'Running');
    const started = Date.now();
    await h.container.infra.commands.requestCancel({
      runId: run.id,
      at: new Date().toISOString(),
    });
    await working;

    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({ status: 'Cancelled' });
    expect(await stepRuns(h.container, run.id)).toEqual([
      expect.objectContaining({
        status: 'Cancelled',
        error: expect.objectContaining({ code: 'EXECUTION_CANCELLED' }),
      }),
    ]);
    expect(await h.container.infra.jobs.get(job.id)).toMatchObject({ status: 'completed' });
  });

  it('interrupts a retry backoff wait', async () => {
    const state = newTestState();
    state.flakyFailures = 99;
    const h = await createHarness({ registry: createTestRegistry(state) });
    const run = makeRun([
      node(
        'call',
        'flaky',
        {},
        { retry: { maxAttempts: 3, initialDelayMs: 60_000, maxDelayMs: 60_000 } },
      ),
    ]);
    await submit(h.container, run);
    const working = h.container.loop.runOnce();

    await waitFor(async () => (await stepRuns(h.container, run.id))[0]?.status === 'Retrying');
    await h.container.infra.commands.requestCancel({
      runId: run.id,
      at: new Date().toISOString(),
    });
    await working;

    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({ status: 'Cancelled' });
    expect(state.flakyCalls).toBe(1);
    expect((await stepRuns(h.container, run.id)).map((step) => step.status)).toEqual(['Cancelled']);
  });

  it('lets a cancellation that arrives after the last Step win over success', async () => {
    const state = newTestState();
    const h = await createHarness({ registry: createTestRegistry(state) });
    state.onHook = async (runId) => {
      await h.container.infra.commands.requestCancel({ runId, at: new Date().toISOString() });
    };
    const run = makeRun([node('only', 'hook')]);
    await submit(h.container, run);
    await h.container.loop.runOnce();
    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({ status: 'Cancelled' });
  });
});

describe('payload caps and artifacts', () => {
  it('truncates the persisted preview, keeps the full output as an artifact, and feeds Steps in full', async () => {
    const state = newTestState();
    const h = await createHarness({ registry: createTestRegistry(state) });
    const run = makeRun(
      [
        node('big', 'big'),
        node('verify', 'assert', {
          actual: '{{steps.big.output.text}}',
          operator: 'equals',
          expected: 'x'.repeat(5_000),
        }),
      ],
      { environment: environment({ limits: { maxPayloadCaptureBytes: 512 } }) },
    );
    await submit(h.container, run);
    await h.container.loop.runOnce();

    const finished = await h.container.infra.runs.getRun(run.id);
    expect(finished?.status, JSON.stringify(finished?.error)).toBe('Succeeded');

    const steps = await stepRuns(h.container, run.id);
    const big = steps.find((step) => step.nodeId === 'big');
    expect(big?.outputPreview).toMatchObject({ $truncated: true });
    expect(JSON.stringify(big?.outputPreview).length).toBeLessThanOrEqual(512);
    const reference = big?.artifacts.find((item) => item.label === 'step-output');
    expect(reference).toBeDefined();
    const stored = await h.container.infra.artifacts.read(reference?.id as string);
    expect(JSON.parse(Buffer.from(stored?.content ?? []).toString('utf8'))).toEqual({
      text: 'x'.repeat(5_000),
    });
    const events = await eventsOf(h.container, run.id);
    expect(events.some((event) => event.type === 'artifact.created')).toBe(true);
  });

  it('bounds the persisted resolved input', async () => {
    const h = await createHarness();
    const run = makeRun([node('shape', 'transform.json', { input: { blob: 'y'.repeat(4_000) } })], {
      environment: environment({ limits: { maxPayloadCaptureBytes: 512 } }),
    });
    await submit(h.container, run);
    await h.container.loop.runOnce();
    const [step] = await stepRuns(h.container, run.id);
    expect(JSON.stringify(step?.resolvedInput).length).toBeLessThanOrEqual(512);
  });
});

describe('redaction', () => {
  it('never persists secret values in Step runs, events, artifacts, Run errors, or logs', async () => {
    const state = newTestState();
    const h = await createHarness({ registry: createTestRegistry(state) });
    const run = makeRun([node('use', 'leak', { fail: true })]);
    await submit(h.container, run);
    await h.container.loop.runOnce();

    const finished = await h.container.infra.runs.getRun(run.id);
    expect(finished).toMatchObject({ status: 'Failed', error: { code: 'TARGET_REQUEST' } });

    const { db } = h.container.infra;
    const dump = ['runs', 'step_runs', 'run_events', 'jobs', 'artifacts', 'audit_events']
      .map((table) => JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()))
      .join('\n');
    expect(dump).not.toContain(SECRET);
    expect(h.logs.join('\n')).not.toContain(SECRET);

    const [step] = await stepRuns(h.container, run.id);
    expect(JSON.stringify(step)).toContain('REDACTED');
    const artifactId = step?.artifacts[0]?.id as string;
    const stored = await h.container.infra.artifacts.read(artifactId);
    expect(Buffer.from(stored?.content ?? []).toString('utf8')).not.toContain(SECRET);
  });
});

describe('Environment values', () => {
  it('exposes non-secret Environment values to expressions', async () => {
    const h = await createHarness();
    const run = makeRun([
      node('check', 'assert', {
        actual: '{{environment.region}}',
        operator: 'equals',
        expected: 'eu',
      }),
    ]);
    await submit(h.container, run);
    await h.container.loop.runOnce();
    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({ status: 'Succeeded' });
  });

  it('applies variable overrides', async () => {
    const h = await createHarness();
    const run = makeRun(
      [
        node('check', 'assert', {
          actual: '{{variables.mode}}',
          operator: 'equals',
          expected: 'fast',
        }),
      ],
      { variables: { mode: 'slow' }, overrides: { mode: 'fast' } },
    );
    await submit(h.container, run);
    await h.container.loop.runOnce();
    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({ status: 'Succeeded' });
  });
});

describe('clock', () => {
  it('stamps Run and Step times from the injected clock', async () => {
    const clock = new FakeClock();
    const h = await createHarness({ clock });
    const run = makeRun([node('check', 'assert', { actual: 1, operator: 'equals', expected: 1 })]);
    await submit(h.container, run);
    await h.container.loop.runOnce();
    expect(await h.container.infra.runs.getRun(run.id)).toMatchObject({
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:00.000Z',
    });
  });
});
