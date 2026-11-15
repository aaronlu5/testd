import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  RunDetail,
  RunSummary,
  StepRun,
  SuiteRunView,
  TestDefinition,
} from '@test-platform/contracts';
import { newId } from '@test-platform/infrastructure-local';
import {
  ENVIRONMENTS,
  SECRET,
  cleanupAll,
  createTestApp,
  dataBody,
  ids,
  type TestApp,
} from './helpers.js';

afterEach(cleanupAll);

type Problem = {
  type: string;
  title: string;
  status: number;
  code: string;
  instance: string;
  requestId: string;
  errors?: { path: string; message: string }[];
};

const post = (t: TestApp, url: string, payload?: object) =>
  t.request({ method: 'POST', url: `/api/v1${url}`, ...(payload ? { payload } : {}) });
const get = (t: TestApp, url: string) => t.request({ url: `/api/v1${url}` });
const rows = (t: TestApp, table: string, where = '1 = 1'): number =>
  Number(
    (
      t.container.infra.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as {
        n: number;
      }
    ).n,
  );

const expectProblem = (
  response: { statusCode: number; headers: Record<string, unknown>; body: string },
  status: number,
  code: string,
): Problem => {
  expect(response.statusCode).toBe(status);
  expect(String(response.headers['content-type'])).toContain('application/problem+json');
  const problem = JSON.parse(response.body) as Problem;
  expect(problem).toMatchObject({ status, code, requestId: expect.any(String) });
  expect(problem.type).toBe(
    `https://test-platform.dev/problems/${code.toLowerCase().replace(/_/g, '-')}`,
  );
  return problem;
};

// ---- fixtures ------------------------------------------------------------------------------------

const breakpointTestBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'Delay, inspect, assert',
  nodes: [
    { id: 'wait', type: 'delay', name: 'Wait', parameters: { durationSeconds: 0.01 } },
    {
      id: 'inspect',
      type: 'breakpoint',
      name: 'Inspect',
      parameters: { enabled: true, message: 'Review' },
    },
    {
      id: 'verify',
      type: 'assert',
      name: 'Verify',
      parameters: { actual: 1, operator: 'equals', expected: 1 },
    },
  ],
  edges: [
    { from: 'wait', to: 'inspect' },
    { from: 'inspect', to: 'verify' },
  ],
  ...overrides,
});

const createRun = async (t: TestApp, body = breakpointTestBody()): Promise<RunSummary> => {
  const test = await ids.create(t, 'tests', body);
  const data = await ids.create(t, 'test-data', dataBody());
  const response = await post(t, '/runs', {
    testId: test.id,
    dataSetId: data.id,
    environmentId: 'local-test',
  });
  expect(response.statusCode).toBe(202);
  return t.json<RunSummary>(response);
};

/** Does what the worker does when it reaches the Breakpoint (the API itself never executes Steps). */
const pauseAsWorker = async (
  t: TestApp,
  runId: string,
  options: { node?: string; priorNode?: string } = {},
) => {
  const { infra } = t.container;
  const node = options.node ?? 'inspect';
  const at = new Date().toISOString();
  const job = (await infra.jobs.claim({ workerId: 'worker-1', leaseMs: 60_000 }))!;
  const run = await infra.runs.getRun(runId);
  if (run?.status === 'Queued')
    await infra.runs.transitionRun(runId, { from: 'Queued', to: 'Running', at });
  if (!options.priorNode) {
    await infra.runs.createStepRun({
      id: newId(),
      runId,
      nodeId: 'wait',
      attempt: 1,
      status: 'Succeeded',
      outputPreview: { actualDurationMs: 10, token: SECRET },
      logs: [],
      artifacts: [],
      startedAt: at,
      finishedAt: at,
      durationMs: 10,
    });
  }
  const stepRunId = newId();
  await infra.runs.createStepRun({
    id: stepRunId,
    runId,
    nodeId: node,
    attempt: 1,
    status: 'Running',
    logs: [],
    artifacts: [],
    startedAt: at,
  });
  const result = await infra.pauses.pauseRun({
    runId,
    jobId: job.id,
    workerId: 'worker-1',
    breakpointStepRunId: stepRunId,
    pause: {
      breakpointNodeId: node,
      message: 'Review',
      nextNodeId: 'verify',
      nextNodeName: 'Verify',
      nextNodeType: 'assert',
      // A preview that slipped through unmasked must still not leave the API.
      nextResolvedInputPreview: { actual: 1, apiKey: SECRET, note: `value ${SECRET}` },
      pausedAt: at,
    },
  });
  expect(result.outcome).toBe('applied');
  return { stepRunId, job };
};

const listen = async (t: TestApp): Promise<string> => {
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  return `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
};

type Message = { id?: string; event?: string; data?: string };
const parse = (text: string): Message[] =>
  text
    .split('\n\n')
    .filter((block) => block.trim() !== '' && !block.startsWith(':') && !block.startsWith('retry:'))
    .map(
      (block) =>
        Object.fromEntries(
          block
            .split('\n')
            .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]),
        ) as Message,
    );

const readUntil = async (
  response: Response,
  done: (messages: Message[]) => boolean,
): Promise<{ messages: Message[]; ended: boolean; raw: string }> => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  for (;;) {
    const { value, done: finished } = await reader.read();
    if (finished) return { messages: parse(raw), ended: true, raw };
    raw += decoder.decode(value, { stream: true });
    if (done(parse(raw))) {
      await reader.cancel();
      return { messages: parse(raw), ended: false, raw };
    }
  }
};

// ---- pause inspection ------------------------------------------------------------------------------

describe('GET /runs/{id}/pause', () => {
  it('returns 404 for a Run that is not paused or does not exist', async () => {
    const t = await createTestApp();
    const run = await createRun(t);
    expectProblem(await get(t, `/runs/${run.id}/pause`), 404, 'VALIDATION_NOT_FOUND');
    expectProblem(await get(t, '/runs/nope/pause'), 404, 'VALIDATION_NOT_FOUND');
  });

  it('aggregates the sanitized pause context with completed Step summaries', async () => {
    const t = await createTestApp();
    const run = await createRun(t);
    await pauseAsWorker(t, run.id);

    const response = await get(t, `/runs/${run.id}/pause`);
    expect(response.statusCode).toBe(200);
    const body = t.json<{
      run: { id: string; status: string; continuationGeneration: number };
      pause: Record<string, unknown>;
      completedSteps: { nodeId: string; status: string; outputPreview: unknown }[];
      lastEventSeq: number;
    }>(response);

    expect(body.run).toMatchObject({ id: run.id, status: 'Paused', continuationGeneration: 0 });
    expect(body.pause).toMatchObject({
      breakpointNodeId: 'inspect',
      message: 'Review',
      nextNodeId: 'verify',
      nextNodeName: 'Verify',
      nextNodeType: 'assert',
      continuationGeneration: 0,
    });
    expect(body.completedSteps.map((s) => [s.nodeId, s.status])).toEqual([['wait', 'Succeeded']]);
    expect(body.lastEventSeq).toBeGreaterThan(0);
  });

  it('never returns secret values or local paths', async () => {
    const t = await createTestApp();
    const run = await createRun(t);
    await pauseAsWorker(t, run.id);

    const response = await get(t, `/runs/${run.id}/pause`);
    expect(response.body).not.toContain(SECRET);
    expect(response.body).toContain('REDACTED');
    expect(response.body).not.toContain(t.dir);
    expect(response.body).not.toMatch(/artifacts[\\/]/);
  });

  it('refers to a stored next-Step input by artifact id only', async () => {
    const t = await createTestApp();
    const run = await createRun(t);
    const { stepRunId } = await pauseAsWorker(t, run.id);
    const artifact = await t.container.infra.artifacts.write({
      runId: run.id,
      stepRunId,
      content: JSON.stringify({ big: 'input' }),
      contentType: 'application/json',
    });
    t.container.infra.db
      .prepare('UPDATE run_pauses SET next_input_artifact_id = ? WHERE run_id = ?')
      .run(artifact.id, run.id);

    const body = t.json<{ pause: { nextInputArtifactId: string } }>(
      await get(t, `/runs/${run.id}/pause`),
    );
    expect(body.pause.nextInputArtifactId).toBe(artifact.id);
    expect(JSON.stringify(body)).not.toContain(t.dir);
    // The id is the only way in, and it goes through the normal artifact endpoint.
    const content = await get(t, `/artifacts/${artifact.id}`);
    expect(content.statusCode).toBe(200);
  });

  it('is reflected in the Run detail, including the sequence to resume events from', async () => {
    const t = await createTestApp();
    const run = await createRun(t);
    await pauseAsWorker(t, run.id);
    const detail = t.json<RunDetail>(await get(t, `/runs/${run.id}`));
    expect(detail).toMatchObject({ status: 'Paused', continuationGeneration: 0 });
    expect(detail.pausedAt).toBeDefined();
    const events = await t.container.infra.events.listSince(run.id);
    expect(detail.lastEventSeq).toBe(events.at(-1)!.seq);
    expect(detail.stepRuns.find((s: StepRun) => s.nodeId === 'inspect')?.status).toBe('Paused');
    expect(JSON.stringify(detail)).not.toContain(SECRET);
  });
});

// ---- resume ----------------------------------------------------------------------------------------

describe('POST /runs/{id}/resume', () => {
  it('requeues the same Run with a new generation and exactly one job', async () => {
    const t = await createTestApp();
    const run = await createRun(t);
    await pauseAsWorker(t, run.id);
    expect(rows(t, 'jobs', "status = 'queued'")).toBe(0);

    const response = await post(t, `/runs/${run.id}/resume`, { continuationGeneration: 0 });
    expect(response.statusCode).toBe(202);
    expect(t.json(response)).toMatchObject({
      run: { id: run.id, status: 'Queued', continuationGeneration: 1 },
      continuationGeneration: 1,
      alreadyResumed: false,
    });
    expect(rows(t, 'jobs', `run_id = '${run.id}' AND status = 'queued'`)).toBe(1);
    // The snapshot is untouched and the Breakpoint attempt stays Paused for the worker to finish.
    const step = (await t.container.infra.runs.listStepRuns(run.id)).find(
      (s) => s.nodeId === 'inspect',
    );
    expect(step?.status).toBe('Paused');
    const types = (await t.container.infra.events.listSince(run.id)).map((e) => e.type);
    expect(types).toContain('run.resumed');
  });

  it('is idempotent for the same generation and queues nothing more', async () => {
    const t = await createTestApp();
    const run = await createRun(t);
    await pauseAsWorker(t, run.id);

    const results = await Promise.all(
      [1, 2, 3].map(() => post(t, `/runs/${run.id}/resume`, { continuationGeneration: 0 })),
    );
    expect(results.map((r) => r.statusCode)).toEqual([202, 202, 202]);
    expect(
      results.map((r) => t.json<{ alreadyResumed: boolean }>(r).alreadyResumed).sort(),
    ).toEqual([false, true, true]);
    expect(rows(t, 'jobs', `run_id = '${run.id}' AND status = 'queued'`)).toBe(1);
    expect((await t.container.infra.runs.getRun(run.id))?.continuationGeneration).toBe(1);
  });

  it('accepts a resume with no body for the active pause', async () => {
    const t = await createTestApp();
    const run = await createRun(t);
    await pauseAsWorker(t, run.id);
    expect((await post(t, `/runs/${run.id}/resume`)).statusCode).toBe(202);
  });

  it('returns a stable 409 problem for a Run that is not paused', async () => {
    const t = await createTestApp();
    const run = await createRun(t);
    const queued = expectProblem(
      await post(t, `/runs/${run.id}/resume`),
      409,
      'EXECUTION_NOT_PAUSED',
    );

    expect(queued.instance).toBe(`/api/v1/runs/${run.id}/resume`);
    expect(rows(t, 'jobs', "status = 'queued'")).toBe(1); // only the original job

    await pauseAsWorker(t, run.id);
    await post(t, `/runs/${run.id}/resume`, { continuationGeneration: 0 });
    // A resume with no generation cannot be matched to an accepted continuation.
    expectProblem(await post(t, `/runs/${run.id}/resume`), 409, 'EXECUTION_NOT_PAUSED');
  });

  it('returns 409 for terminal Runs and 404 for unknown ones', async () => {
    const t = await createTestApp();
    const run = await createRun(t);
    await post(t, `/runs/${run.id}/cancel`);
    expectProblem(
      await post(t, `/runs/${run.id}/resume`, { continuationGeneration: 0 }),
      409,
      'EXECUTION_NOT_PAUSED',
    );
    expectProblem(await post(t, '/runs/unknown-run/resume'), 404, 'VALIDATION_NOT_FOUND');
  });

  it('rejects a stale generation with 409 and leaves the Run paused', async () => {
    const t = await createTestApp();
    const run = await createRun(t);
    await pauseAsWorker(t, run.id);
    await post(t, `/runs/${run.id}/resume`, { continuationGeneration: 0 });

    // The continuation ran and paused again at a second Breakpoint (generation 1).
    await t.container.infra.runs.updateStepRun(
      (await t.container.infra.runs.listStepRuns(run.id)).find((s) => s.nodeId === 'inspect')!.id,
      { status: 'Succeeded' },
      'Paused',
    );
    await pauseAsWorker(t, run.id, { node: 'inspect-2', priorNode: 'inspect' });

    expectProblem(
      await post(t, `/runs/${run.id}/resume`, { continuationGeneration: 0 }),
      409,
      'EXECUTION_STALE_CONTINUATION',
    );
    expect((await t.container.infra.runs.getRun(run.id))?.status).toBe('Paused');
    expect((await get(t, `/runs/${run.id}/pause`)).json()).toMatchObject({
      pause: { breakpointNodeId: 'inspect-2', continuationGeneration: 1 },
    });
    expect(
      (await post(t, `/runs/${run.id}/resume`, { continuationGeneration: 1 })).statusCode,
    ).toBe(202);
  });

  it('accepts no variable overrides, input changes or Environment changes', async () => {
    const t = await createTestApp();
    const run = await createRun(t);
    await pauseAsWorker(t, run.id);
    for (const payload of [
      { variableOverrides: { a: 1 } },
      { environmentId: 'other' },
      { input: { actual: 2 } },
      { continuationGeneration: -1 },
      { continuationGeneration: 'zero' },
    ]) {
      const response = await post(t, `/runs/${run.id}/resume`, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).toBeLessThan(500);
    }
    expect((await t.container.infra.runs.getRun(run.id))?.status).toBe('Paused');
    expect(rows(t, 'jobs', "status = 'queued'")).toBe(0);
  });
});

// ---- cancellation while paused ----------------------------------------------------------------------

describe('POST /runs/{id}/cancel while paused', () => {
  it('cancels the Run and the Breakpoint attempt directly', async () => {
    const t = await createTestApp();
    const run = await createRun(t);
    await pauseAsWorker(t, run.id);

    const response = await post(t, `/runs/${run.id}/cancel`);
    expect(response.statusCode).toBe(202);
    expect(t.json<RunSummary>(response)).toMatchObject({ id: run.id, status: 'Cancelled' });

    const steps = await t.container.infra.runs.listStepRuns(run.id);
    expect(steps.find((s) => s.nodeId === 'inspect')?.status).toBe('Cancelled');
    expect(steps.some((s) => s.nodeId === 'verify')).toBe(false);
    expect(rows(t, 'jobs', "status = 'queued'")).toBe(0);
    expect((await get(t, `/runs/${run.id}/pause`)).statusCode).toBe(404);

    const types = (await t.container.infra.events.listSince(run.id)).map((e) => e.type);
    expect(types.at(-1)).toBe('run.cancelled');
    expectProblem(
      await post(t, `/runs/${run.id}/resume`, { continuationGeneration: 0 }),
      409,
      'EXECUTION_NOT_PAUSED',
    );
  });

  it('is idempotent for a paused Run and a 409 for a finished one', async () => {
    const t = await createTestApp();
    const run = await createRun(t);
    await pauseAsWorker(t, run.id);
    expect((await post(t, `/runs/${run.id}/cancel`)).statusCode).toBe(202);
    expect((await post(t, `/runs/${run.id}/cancel`)).statusCode).toBe(202);

    const done = await createRun(t);
    t.container.infra.db.prepare("UPDATE runs SET status = 'Succeeded' WHERE id = ?").run(done.id);
    expectProblem(await post(t, `/runs/${done.id}/cancel`), 409, 'VALIDATION_CONFLICT');
  });
});

// ---- SSE -------------------------------------------------------------------------------------------

describe('SSE payloads', () => {
  it('delivers run.paused and run.step.updated and keeps the stream open while paused', async () => {
    const t = await createTestApp();
    const run = await createRun(t);
    await pauseAsWorker(t, run.id);
    const base = await listen(t);

    const response = await fetch(`${base}/api/v1/runs/${run.id}/events`);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const { messages, ended } = await readUntil(response, (m) =>
      m.some((x) => x.event === 'run.paused'),
    );
    expect(ended).toBe(false); // Paused is not terminal, so the stream is still open

    const types = messages.map((m) => m.event);
    expect(types).toEqual(expect.arrayContaining(['run.status', 'run.step.updated', 'run.paused']));
    const paused = JSON.parse(messages.find((m) => m.event === 'run.paused')!.data!);
    expect(paused).toMatchObject({
      type: 'run.paused',
      runId: run.id,
      data: { breakpointNodeId: 'inspect', nextNodeId: 'verify', continuationGeneration: 0 },
    });
    const updated = JSON.parse(messages.find((m) => m.event === 'run.step.updated')!.data!);
    expect(updated.data).toMatchObject({ nodeId: 'inspect', status: 'Paused' });
    expect(messages.every((m) => !m.data?.includes(SECRET))).toBe(true);
  });

  it('delivers run.resumed live and ends the stream with the cancellation', async () => {
    const t = await createTestApp();
    const run = await createRun(t);
    await pauseAsWorker(t, run.id);
    const base = await listen(t);

    const stream = fetch(`${base}/api/v1/runs/${run.id}/events`).then((response) =>
      readUntil(response, () => false),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await post(t, `/runs/${run.id}/resume`, { continuationGeneration: 0 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await post(t, `/runs/${run.id}/cancel`); // Queued -> Cancelled ends the stream

    const { messages, ended } = await stream;
    expect(ended).toBe(true);
    expect(messages.map((m) => m.event)).toEqual(
      expect.arrayContaining(['run.paused', 'run.resumed', 'run.status', 'end']),
    );
    const resumed = JSON.parse(messages.find((m) => m.event === 'run.resumed')!.data!);
    expect(resumed.data).toMatchObject({ continuationGeneration: 1 });
    const ids = messages.filter((m) => m.id).map((m) => Number(m.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it('lets a reconnecting client recover from the full GET plus its lastEventSeq', async () => {
    const t = await createTestApp();
    const run = await createRun(t);
    await pauseAsWorker(t, run.id);

    // A client that missed everything reads the full state, then continues from lastEventSeq.
    const detail = t.json<RunDetail>(await get(t, `/runs/${run.id}`));
    expect(detail.status).toBe('Paused');
    await post(t, `/runs/${run.id}/resume`, { continuationGeneration: 0 });
    await post(t, `/runs/${run.id}/cancel`);

    const base = await listen(t);
    const response = await fetch(`${base}/api/v1/runs/${run.id}/events`, {
      headers: { 'Last-Event-ID': String(detail.lastEventSeq) },
    });
    const { messages, ended } = await readUntil(response, () => false);
    expect(ended).toBe(true);
    const seqs = messages.filter((m) => m.id).map((m) => Number(m.id));
    expect(seqs.length).toBeGreaterThan(0);
    expect(seqs.every((seq) => seq > detail.lastEventSeq!)).toBe(true);
    expect(messages.map((m) => m.event)).not.toContain('run.paused'); // already covered by the GET
    expect(messages.map((m) => m.event)).toContain('run.resumed');

    // The state needed to recover never depends on history: the detail alone says it is final.
    const final = t.json<RunDetail>(await get(t, `/runs/${run.id}`));
    expect(final.status).toBe('Cancelled');
    expect(final.lastEventSeq).toBeGreaterThanOrEqual(seqs.at(-1)!);
  });
});

// ---- Suite Runs -------------------------------------------------------------------------------------

const envWithLimit = (maxSuiteConcurrency?: number, extra: Record<string, unknown> = {}) => ({
  environments: [
    {
      ...ENVIRONMENTS.environments[0],
      limits: {
        maxStepTimeoutSeconds: 60,
        maxRetryAttempts: 3,
        ...(maxSuiteConcurrency ? { maxSuiteConcurrency } : {}),
        ...extra,
      },
    },
  ],
});

const createSuite = async (t: TestApp, count = 2, suiteExtra: Record<string, unknown> = {}) => {
  const data = await ids.create(t, 'test-data', dataBody());
  const items: { testId: string; dataSetId: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    const test = await ids.create(t, 'tests', breakpointTestBody({ name: `Suite test ${i}` }));
    items.push({ testId: test.id, dataSetId: data.id });
  }
  const suite = await ids.create(t, 'suites', { name: 'Smoke suite', items, ...suiteExtra });
  return { suite, items, data };
};

describe('Suite Runs', () => {
  it('creates a Suite Run with snapshots, ordered Pending children, and no direct execution', async () => {
    const t = await createTestApp();
    const { suite } = await createSuite(t, 3);

    const response = await post(t, '/suite-runs', {
      suiteId: suite.id,
      environmentId: 'local-test',
    });
    expect(response.statusCode).toBe(202);
    const created = t.json<SuiteRunView>(response);
    expect(response.headers.location).toBe(`/api/v1/suite-runs/${created.id}`);
    expect(created).toMatchObject({
      status: 'Queued',
      suiteName: 'Smoke suite',
      suite: { id: suite.id, version: 1 },
      environmentId: 'local-test',
      maxConcurrency: 1,
      requestedBy: 'local-dev-user',
      counts: { total: 3, Pending: 3, Running: 0 },
    });
    expect(created.items.map((i) => [i.position, i.status, i.testName])).toEqual([
      [0, 'Pending', 'Suite test 0'],
      [1, 'Pending', 'Suite test 1'],
      [2, 'Pending', 'Suite test 2'],
    ]);
    expect(response.body).not.toContain('snapshots');
    // Snapshots are stored, but the API creates no child Runs and executes nothing.
    const stored = await t.container.infra.suiteRuns.getSuiteRun(created.id);
    expect(stored?.snapshots.tests).toHaveLength(3);
    expect(stored?.snapshots.environment.id).toBe('local-test');
    expect(rows(t, 'runs')).toBe(0);
    expect(rows(t, 'jobs')).toBe(0);

    expect(t.json<SuiteRunView>(await get(t, `/suite-runs/${created.id}`))).toMatchObject({
      id: created.id,
      counts: { Pending: 3 },
    });
    const list = t.json<{ items: { id: string; items?: unknown }[] }>(await get(t, '/suite-runs'));
    expect(list.items.map((i) => i.id)).toEqual([created.id]);
    expect(list.items[0]?.items).toBeUndefined();
  });

  it('validates references, bodies and Test policy before storing anything', async () => {
    const t = await createTestApp();
    const { suite } = await createSuite(t, 1);

    expectProblem(
      await post(t, '/suite-runs', { suiteId: 'missing', environmentId: 'local-test' }),
      422,
      'VALIDATION_REFERENCE',
    );
    expectProblem(
      await post(t, '/suite-runs', { suiteId: suite.id, environmentId: 'nope' }),
      422,
      'VALIDATION_REFERENCE',
    );
    expect((await post(t, '/suite-runs', { suiteId: suite.id })).statusCode).toBe(400);
    expect(
      (await post(t, '/suite-runs', { suiteId: suite.id, environmentId: 'local-test', extra: 1 }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await post(t, '/suite-runs', {
          suiteId: suite.id,
          environmentId: 'local-test',
          maxConcurrency: 0,
        })
      ).statusCode,
    ).toBe(400);
    expectProblem(
      await post(t, '/suite-runs', {
        suiteId: suite.id,
        environmentId: 'local-test',
        variableOverrides: { password: 'x' },
      }),
      422,
      'VALIDATION_SCHEMA',
    );
    expect(rows(t, 'suite_runs')).toBe(0);
  });

  it('rejects a Suite containing a Test that violates the Environment policy, naming the item', async () => {
    const t = await createTestApp();
    const data = await ids.create(t, 'test-data', dataBody());
    const bad = await ids.create(
      t,
      'tests',
      breakpointTestBody({
        nodes: [
          {
            id: 'wait',
            type: 'delay',
            name: 'Wait',
            parameters: { durationSeconds: 1 },
            execution: { timeoutSeconds: 9999 },
          },
        ],
        edges: [],
      }),
    );
    const suite = await ids.create(t, 'suites', {
      name: 'Bad',
      items: [{ testId: bad.id, dataSetId: data.id }],
    });
    const problem = expectProblem(
      await post(t, '/suite-runs', { suiteId: suite.id, environmentId: 'local-test' }),
      422,
      'VALIDATION_TARGET_POLICY',
    );
    expect(problem.errors?.[0]?.path).toBe('/items/0/nodes/0/execution/timeoutSeconds');
    expect(rows(t, 'suite_runs')).toBe(0);
  });

  it('enforces bounded concurrency from the Environment (default 1)', async () => {
    const strict = await createTestApp();
    const { suite } = await createSuite(strict, 2);
    const refused = expectProblem(
      await post(strict, '/suite-runs', {
        suiteId: suite.id,
        environmentId: 'local-test',
        maxConcurrency: 2,
      }),
      422,
      'VALIDATION_TARGET_POLICY',
    );
    expect(refused.errors?.[0]?.path).toBe('/maxConcurrency');
    expect(rows(strict, 'suite_runs')).toBe(0);
    expect(
      (
        await post(strict, '/suite-runs', {
          suiteId: suite.id,
          environmentId: 'local-test',
          maxConcurrency: 1,
        })
      ).statusCode,
    ).toBe(202);

    const roomy = await createTestApp({ environments: envWithLimit(3) });
    const second = await createSuite(roomy, 2);
    const ok = roomy.json<SuiteRunView>(
      await post(roomy, '/suite-runs', {
        suiteId: second.suite.id,
        environmentId: 'local-test',
        maxConcurrency: 3,
      }),
    );
    expect(ok.maxConcurrency).toBe(3);
    expectProblem(
      await post(roomy, '/suite-runs', {
        suiteId: second.suite.id,
        environmentId: 'local-test',
        maxConcurrency: 4,
      }),
      422,
      'VALIDATION_TARGET_POLICY',
    );
    // Without a request, the Suite default applies but is capped by the Environment.
    const defaulted = await createSuite(roomy, 1, { maxConcurrency: 9 });
    expect(
      roomy.json<SuiteRunView>(
        await post(roomy, '/suite-runs', {
          suiteId: defaulted.suite.id,
          environmentId: 'local-test',
        }),
      ).maxConcurrency,
    ).toBe(3);
  });

  it('enforces the Environment maxSuiteSize', async () => {
    const t = await createTestApp({ environments: envWithLimit(undefined, { maxSuiteSize: 1 }) });
    const { suite } = await createSuite(t, 2);
    expectProblem(
      await post(t, '/suite-runs', { suiteId: suite.id, environmentId: 'local-test' }),
      422,
      'VALIDATION_TARGET_POLICY',
    );
  });

  it('cancels a Suite Run, skipping undispatched children, and is idempotent', async () => {
    const t = await createTestApp();
    const { suite } = await createSuite(t, 2);
    const created = t.json<SuiteRunView>(
      await post(t, '/suite-runs', { suiteId: suite.id, environmentId: 'local-test' }),
    );

    const response = await post(t, `/suite-runs/${created.id}/cancel`);
    expect(response.statusCode).toBe(202);
    expect(t.json<SuiteRunView>(response)).toMatchObject({
      status: 'Cancelled',
      counts: { Skipped: 2, Pending: 0 },
    });
    expect((await post(t, `/suite-runs/${created.id}/cancel`)).statusCode).toBe(202);
    expectProblem(await post(t, '/suite-runs/missing/cancel'), 404, 'VALIDATION_NOT_FOUND');
  });

  it('refuses to cancel a finished Suite Run or rerun an active one', async () => {
    const t = await createTestApp();
    const { suite } = await createSuite(t, 1);
    const created = t.json<SuiteRunView>(
      await post(t, '/suite-runs', { suiteId: suite.id, environmentId: 'local-test' }),
    );
    expectProblem(await post(t, `/suite-runs/${created.id}/rerun`), 409, 'VALIDATION_CONFLICT');

    t.container.infra.db
      .prepare("UPDATE suite_runs SET status = 'Succeeded' WHERE id = ?")
      .run(created.id);
    expectProblem(await post(t, `/suite-runs/${created.id}/cancel`), 409, 'VALIDATION_CONFLICT');
  });

  it('reruns a finished Suite Run from its stored snapshots', async () => {
    const t = await createTestApp();
    const { suite, items } = await createSuite(t, 2);
    const first = t.json<SuiteRunView>(
      await post(t, '/suite-runs', { suiteId: suite.id, environmentId: 'local-test' }),
    );
    await post(t, `/suite-runs/${first.id}/cancel`);

    // Live definitions change afterwards; the rerun must not see it.
    const edited = await t.request({
      method: 'PUT',
      url: `/api/v1/suites/${suite.id}`,
      payload: { name: 'Renamed', version: 1, items: items.slice(0, 1) },
    });
    expect(edited.statusCode).toBe(200);

    const response = await post(t, `/suite-runs/${first.id}/rerun`);
    expect(response.statusCode).toBe(202);
    const rerun = t.json<SuiteRunView>(response);
    expect(response.headers.location).toBe(`/api/v1/suite-runs/${rerun.id}`);
    expect(rerun).toMatchObject({
      status: 'Queued',
      rerunOfSuiteRunId: first.id,
      suiteName: 'Smoke suite',
      suite: { version: 1 },
      counts: { total: 2, Pending: 2 },
    });
    expect(rerun.id).not.toBe(first.id);
    expect(rows(t, 'suite_runs')).toBe(2);
    expect((await get(t, `/suite-runs/${first.id}`)).json()).toMatchObject({ status: 'Cancelled' });
  });

  it('streams suiteRun.updated and ends once the Suite Run is final', async () => {
    const t = await createTestApp();
    const { suite } = await createSuite(t, 1);
    const created = t.json<SuiteRunView>(
      await post(t, '/suite-runs', { suiteId: suite.id, environmentId: 'local-test' }),
    );
    expect(created.lastEventSeq).toBeGreaterThan(0);
    await post(t, `/suite-runs/${created.id}/cancel`);
    const base = await listen(t);

    const response = await fetch(`${base}/api/v1/suite-runs/${created.id}/events`);
    const { messages, ended } = await readUntil(response, () => false);
    expect(ended).toBe(true);
    const updates = messages.filter((m) => m.event === 'suiteRun.updated');
    expect(updates.length).toBeGreaterThanOrEqual(2);
    const last = JSON.parse(updates.at(-1)!.data!);
    expect(last).toMatchObject({
      type: 'suiteRun.updated',
      suiteRunId: created.id,
      data: { status: 'Cancelled', counts: { total: 1, Skipped: 1 } },
    });
    expect(messages.at(-1)?.event).toBe('end');

    // A client that already has the first update resumes after it.
    const resumed = await fetch(`${base}/api/v1/suite-runs/${created.id}/events`, {
      headers: { 'Last-Event-ID': String(created.lastEventSeq) },
    });
    const tail = await readUntil(resumed, () => false);
    expect(tail.messages.filter((m) => m.event === 'suiteRun.updated').length).toBe(
      updates.length - 1,
    );
    expectProblem(await get(t, '/suite-runs/missing'), 404, 'VALIDATION_NOT_FOUND');
  });

  it('shows worker progress through the same read model and masks secrets', async () => {
    const t = await createTestApp();
    const { suite } = await createSuite(t, 2);
    const created = t.json<SuiteRunView>(
      await post(t, '/suite-runs', { suiteId: suite.id, environmentId: 'local-test' }),
    );
    // The worker's scheduler would do this; the API only reports it.
    await t.container.infra.suiteCommands.advance(created.id);
    const view = t.json<SuiteRunView>(await get(t, `/suite-runs/${created.id}`));
    expect(view).toMatchObject({ status: 'Running', counts: { Queued: 1, Pending: 1 } });
    expect(view.items[0]?.runId).toBeDefined();
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });
});

// ---- position-managed Tests -------------------------------------------------------------------------

const node = (id: string, y: number, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'delay',
  name: `Step ${id}`,
  parameters: { durationSeconds: 0.01 },
  position: { x: 0, y },
  ...extra,
});

const positioned = (overrides: Record<string, unknown> = {}) => ({
  name: 'Positioned',
  editor: { layoutDirection: 'vertical', autoSequenceFromPosition: true },
  nodes: [node('a', 0), node('b', 100), node('c', 200)],
  edges: [],
  ...overrides,
});

const pairs = (test: Pick<TestDefinition, 'edges'>) => test.edges.map((e) => `${e.from}>${e.to}`);

describe('position-managed Tests', () => {
  it('generates system-managed edges on create, whatever edges the client sent', async () => {
    const t = await createTestApp();
    const response = await post(t, '/tests', positioned({ edges: [{ from: 'c', to: 'a' }] }));
    expect(response.statusCode).toBe(201);
    const test = t.json<TestDefinition>(response);
    expect(test).toMatchObject({
      schemaVersion: 2,
      editor: { layoutDirection: 'vertical', autoSequenceFromPosition: true },
    });
    expect(pairs(test)).toEqual(['a>b', 'b>c']);
    expect(test.edges.every((e) => e.metadata?.systemManaged === true)).toBe(true);
    // No order existed to be changed (the client edge was not a valid sequence): no warning.
    expect(response.headers['x-platform-warnings']).toBeUndefined();
    expect(t.json<TestDefinition>(await get(t, `/tests/${test.id}`))).toEqual(test);
  });

  it('defaults new Tests with positioned nodes to position sequencing', async () => {
    const t = await createTestApp();
    const response = await post(t, '/tests', positioned({ editor: undefined, edges: undefined }));
    expect(t.json<TestDefinition>(response)).toMatchObject({
      schemaVersion: 2,
      editor: { autoSequenceFromPosition: true },
    });
  });

  it('re-sequences when a node is moved above another and warns that the order changed', async () => {
    const t = await createTestApp();
    const created = t.json<TestDefinition>(await post(t, '/tests', positioned()));

    const moved = await t.request({
      method: 'PUT',
      url: `/api/v1/tests/${created.id}`,
      payload: {
        ...positioned({ nodes: [node('a', 0), node('b', 100), node('c', -50)] }),
        version: 1,
        // The client still sends the old order; the server's positions win.
        edges: created.edges,
      },
    });
    expect(moved.statusCode).toBe(200);
    expect(pairs(moved.json())).toEqual(['c>a', 'a>b']);
    expect(moved.headers['x-platform-warnings']).toBe('FLOW_ORDER_CHANGED');
    expect(String(moved.headers.warning)).toContain('recalculated');

    // The saved version, and version history, carry the normalized order.
    expect(pairs(t.json<TestDefinition>(await get(t, `/tests/${created.id}`)))).toEqual([
      'c>a',
      'a>b',
    ]);
    expect(pairs(t.json<TestDefinition>(await get(t, `/tests/${created.id}?version=1`)))).toEqual([
      'a>b',
      'b>c',
    ]);
  });

  it('keeps stored editor settings when an update omits them', async () => {
    const t = await createTestApp();
    const created = t.json<TestDefinition>(await post(t, '/tests', positioned()));
    const body = { ...positioned({ nodes: [node('a', 50), node('b', 0)] }), version: 1 };
    delete (body as Record<string, unknown>).editor;
    const updated = await t.request({
      method: 'PUT',
      url: `/api/v1/tests/${created.id}`,
      payload: body,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ editor: { autoSequenceFromPosition: true } });
    expect(pairs(updated.json())).toEqual(['b>a']);
  });

  it('rejects position-managed nodes without numeric positions', async () => {
    const t = await createTestApp();
    const response = await post(
      t,
      '/tests',
      positioned({
        nodes: [
          node('a', 0),
          { id: 'b', type: 'delay', name: 'B', parameters: { durationSeconds: 1 } },
        ],
      }),
    );
    const problem = expectProblem(response, 422, 'VALIDATION_FLOW');
    expect(problem.errors?.some((e) => e.message.includes('position'))).toBe(true);
    expect(rows(t, 'assets', "type = 'test'")).toBe(0);
  });

  it('leaves legacy Tests alone: stored edges stay authoritative and sequencing is opt-in', async () => {
    const t = await createTestApp();
    const legacy = await ids.create(t, 'tests', {
      name: 'Legacy',
      nodes: [node('a', 300), node('b', 0)].map((n) => ({ ...n, position: undefined })),
      edges: [{ from: 'a', to: 'b' }],
    });
    const fetched = t.json<TestDefinition>(await get(t, `/tests/${legacy.id}`));
    expect(fetched).toMatchObject({
      schemaVersion: 2,
      editor: { layoutDirection: 'vertical', autoSequenceFromPosition: false },
    });
    expect(pairs(fetched)).toEqual(['a>b']);

    // Saving the presented Test back keeps the hand-authored edges.
    const resaved = await t.request({
      method: 'PUT',
      url: `/api/v1/tests/${legacy.id}`,
      payload: { ...fetched, schemaVersion: undefined, metadata: undefined, id: undefined },
    });
    expect(resaved.statusCode).toBe(200);
    expect(pairs(resaved.json())).toEqual(['a>b']);
    expect(resaved.headers['x-platform-warnings']).toBeUndefined();
  });

  it('validate returns the normalized layout and an order-change warning without saving', async () => {
    const t = await createTestApp();
    const created = t.json<TestDefinition>(await post(t, '/tests', positioned()));

    const response = await post(t, `/tests/${created.id}/validate`, {
      test: positioned({
        nodes: [node('a', 0), node('b', 100), node('c', -50)],
        edges: created.edges,
      }),
    });
    expect(response.statusCode).toBe(200);
    const report = t.json<{
      valid: boolean;
      order: string[];
      warnings: { code: string }[];
      normalization: {
        orderChanged: boolean;
        previousOrder: string[];
        order: string[];
        moves: string[];
      };
      normalized: { editor: unknown; edges: { from: string; to: string }[] };
    }>(response);
    expect(report).toMatchObject({
      valid: true,
      order: ['c', 'a', 'b'],
      warnings: [{ code: 'FLOW_ORDER_CHANGED' }],
      normalization: { orderChanged: true, previousOrder: ['a', 'b', 'c'], order: ['c', 'a', 'b'] },
      normalized: { editor: { autoSequenceFromPosition: true } },
    });
    expect(report.normalization.moves).toContain(
      'Step c moved from position 3 to position 1; connections updated.',
    );
    expect(report.normalized.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['c>a', 'a>b']);
    // Nothing was saved.
    expect(pairs(t.json<TestDefinition>(await get(t, `/tests/${created.id}`)))).toEqual([
      'a>b',
      'b>c',
    ]);
    expect(rows(t, 'asset_versions')).toBe(1);
  });

  it('validate reports a legacy Test unchanged, with no warnings', async () => {
    const t = await createTestApp();
    const { id } = await ids.create(t, 'tests', breakpointTestBody());
    const report = t.json<{ valid: boolean; warnings: unknown[]; normalization?: unknown }>(
      await post(t, `/tests/${id}/validate`),
    );
    expect(report).toMatchObject({ valid: true, warnings: [] });
    expect(report.normalization).toBeUndefined();
  });

  it('runs a position-managed Test using the normalized order in its snapshot', async () => {
    const t = await createTestApp();
    const created = t.json<TestDefinition>(
      await post(t, '/tests', positioned({ nodes: [node('a', 20), node('b', 10)] })),
    );
    const data = await ids.create(t, 'test-data', dataBody());
    const run = t.json<RunSummary>(
      await post(t, '/runs', {
        testId: created.id,
        dataSetId: data.id,
        environmentId: 'local-test',
      }),
    );
    const stored = await t.container.infra.runs.getRun(run.id);
    expect(stored?.snapshots.test?.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['b>a']);
  });
});

// ---- readiness --------------------------------------------------------------------------------------

describe('GET /health/ready secrets', () => {
  const withReferences = {
    environments: [
      {
        ...ENVIRONMENTS.environments[0],
        targets: {
          'example-api': {
            kind: 'http',
            baseUrl: 'https://example.invalid/api',
            allowedPaths: ['/orders/*'],
            authentication: {
              type: 'secretReference',
              provider: 'keyVault',
              name: 'orders-api-key',
            },
          },
          'example-bus': {
            kind: 'azureServiceBus',
            fullyQualifiedNamespace: 'example.servicebus.windows.net',
            allowedEntities: ['events'],
            credential: {
              type: 'secretReference',
              provider: 'localPlainText',
              name: 'bus-connection',
            },
          },
        },
      },
    ],
  };

  it('reports provider configuration and reference counts without values', async () => {
    const t = await createTestApp();
    const response = await t.request({ url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ready',
      secrets: {
        providers: { localPlainText: 'configured', keyVault: 'unconfigured' },
        references: { total: 1, available: 1, missing: 0, unconfigured: 0 },
        status: 'ok',
      },
    });
    expect(response.body).not.toContain(SECRET);
  });

  it('degrades, without failing readiness, when referenced secrets are missing or unconfigured', async () => {
    const t = await createTestApp({
      environments: withReferences,
      env: { TEST_PLATFORM_SECRET_BUS_CONNECTION: undefined },
    });
    const response = await t.request({ url: '/health/ready' });
    expect(response.statusCode).toBe(200); // informational: only Steps that use the secret fail
    expect(response.json()).toMatchObject({
      status: 'ready',
      secrets: {
        providers: { keyVault: 'unconfigured' },
        references: { total: 2, available: 0, missing: 1, unconfigured: 1 },
        status: 'degraded',
      },
    });
  });

  it('treats Key Vault references as configured when a vault is set, without contacting it', async () => {
    const t = await createTestApp({
      environments: withReferences,
      env: {
        TEST_PLATFORM_KEY_VAULT_URL: 'https://orders-kv.vault.azure.net',
        TEST_PLATFORM_SECRET_BUS_CONNECTION:
          'Endpoint=sb://example.servicebus.windows.net/;SharedAccessKeyName=send;SharedAccessKey=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==',
      },
    });
    const response = await t.request({ url: '/health/ready' });
    expect(response.json()).toMatchObject({
      secrets: {
        providers: { keyVault: 'configured' },
        references: { total: 2, available: 2, missing: 0, unconfigured: 0 },
        status: 'ok',
      },
    });
    expect(response.body).not.toContain('Zm9vYmFy');
    expect(response.body).not.toContain('orders-kv');
  });

  it('keeps readiness answering when the Environment file is unavailable', async () => {
    const t = await createTestApp({ environments: null });
    const response = await t.request({ url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json().secrets).toBeUndefined();
  });
});
