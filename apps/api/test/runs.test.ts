import { afterEach, describe, expect, it } from 'vitest';
import type { RunDetail, RunSummary, StepRun } from '@test-platform/contracts';
import {
  SECRET,
  cleanupAll,
  createTestApp,
  dataBody,
  ids,
  seedRunInputs,
  testBody,
  type TestApp,
} from './helpers.js';

afterEach(cleanupAll);

type Problem = { code: string; errors?: { path: string; message: string }[] };

const createRun = (t: TestApp, body: object) =>
  t.request({ method: 'POST', url: '/api/v1/runs', payload: body });
const rowCount = (t: TestApp, table: string): number =>
  Number(
    (t.container.infra.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
  );

describe('POST /runs', () => {
  it('queues a Run and its job atomically and returns 202 with a Location', async () => {
    const t = await createTestApp();
    const inputs = await seedRunInputs(t);
    const response = await createRun(t, { ...inputs, variableOverrides: {} });

    expect(response.statusCode).toBe(202);
    const run = t.json<RunSummary>(response);
    expect(run).toMatchObject({
      kind: 'test',
      status: 'Queued',
      requestedBy: 'local-dev-user',
      environmentId: 'local-test',
      test: { version: 1 },
      testData: { version: 1 },
    });
    expect(response.headers.location).toBe(`/api/v1/runs/${run.id}`);
    expect(response.body).not.toContain('snapshots');

    expect(await t.container.infra.runs.getRun(run.id)).toMatchObject({ status: 'Queued' });
    const job = t.container.infra.db.prepare('SELECT status, run_id FROM jobs').get() as {
      status: string;
      run_id: string;
    };
    expect(job).toEqual({ status: 'queued', run_id: run.id });
    expect(await t.container.infra.events.listSince(run.id)).toEqual([
      expect.objectContaining({ type: 'run.status', data: { status: 'Queued' } }),
    ]);
    expect(
      t.container.infra.db
        .prepare("SELECT actor FROM audit_events WHERE action = 'run.create'")
        .get(),
    ).toEqual({ actor: 'local-dev-user' });
  });

  it('numbers the Runs of a Test 1, 2, 3 and serves the global variable catalogue', async () => {
    const t = await createTestApp();
    const inputs = await seedRunInputs(t);
    const first = t.json<RunSummary>(await createRun(t, inputs));
    const second = t.json<RunSummary>(await createRun(t, inputs));
    expect([first.runNumber, second.runNumber]).toEqual([1, 2]);

    const globals = t.json<{ items: { name: string; description: string; example: string }[] }>(
      await t.request({ url: '/api/v1/globals' }),
    );
    expect(globals.items.map((item) => item.name)).toEqual(
      expect.arrayContaining(['runId', 'runNumber', 'testId']),
    );
    for (const item of globals.items) {
      expect(item.description).not.toBe('');
      expect(item.example).toMatch(/^[A-Za-z0-9-]+$/);
    }
  });

  it('never executes a Step in the API process: nothing runs and no step runs exist', async () => {
    const t = await createTestApp();
    const run = t.json<RunSummary>(await createRun(t, await seedRunInputs(t)));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(rowCount(t, 'step_runs')).toBe(0);
    expect((await t.container.infra.runs.getRun(run.id))?.status).toBe('Queued');
  });

  it('rejects unknown references, environments, and body properties', async () => {
    const t = await createTestApp();
    const inputs = await seedRunInputs(t);

    const unknownTest = await createRun(t, { ...inputs, testId: 'no-such-test' });
    expect(unknownTest.statusCode).toBe(422);
    expect(t.json<Problem>(unknownTest).code).toBe('VALIDATION_REFERENCE');

    expect((await createRun(t, { ...inputs, dataSetId: 'no-such-data' })).statusCode).toBe(422);
    expect((await createRun(t, { ...inputs, testVersion: 7 })).statusCode).toBe(422);
    expect(t.json<Problem>(await createRun(t, { ...inputs, environmentId: 'nowhere' })).code).toBe(
      'VALIDATION_REFERENCE',
    );

    const extra = await createRun(t, { ...inputs, retries: 5 });
    expect(extra.statusCode).toBe(400);
    expect((await createRun(t, { testId: inputs.testId })).statusCode).toBe(400);
    expect(rowCount(t, 'runs')).toBe(0);
    expect(rowCount(t, 'jobs')).toBe(0);
  });

  it('rejects Test Data that cannot satisfy the Test before queuing anything', async () => {
    const t = await createTestApp();
    const test = await ids.create(t, 'tests', testBody());
    const data = await ids.create(t, 'test-data', dataBody({ data: { other: 1 } }));
    const response = await createRun(t, {
      testId: test.id,
      dataSetId: data.id,
      environmentId: 'local-test',
    });
    expect(response.statusCode).toBe(422);
    expect(t.json<Problem>(response).code).toBe('VALIDATION_EXPRESSION');
    expect(rowCount(t, 'runs')).toBe(0);
  });

  it('validates variable overrides: declared names only, and never secrets', async () => {
    const t = await createTestApp();
    const inputs = await seedRunInputs(t);

    const accepted = await createRun(t, { ...inputs, variableOverrides: { orderId: 'ORD-9' } });
    expect(accepted.statusCode).toBe(202);
    expect(t.json<RunSummary>(accepted).variableOverrides).toEqual({ orderId: 'ORD-9' });

    const unknown = await createRun(t, { ...inputs, variableOverrides: { nothing: 'x' } });
    expect(unknown.statusCode).toBe(422);

    const secret = await createRun(t, {
      ...inputs,
      variableOverrides: { orderId: 'x', apiKey: SECRET },
    });
    expect(secret.statusCode).toBe(422);
    expect(secret.body).not.toContain(SECRET);
    expect(t.json<Problem>(secret).errors?.[0]?.path).toBe('/variableOverrides/apiKey');
  });

  it('refuses to run a Test that violates the Environment target policy', async () => {
    const t = await createTestApp();
    const test = await ids.create(
      t,
      'tests',
      testBody({
        nodes: [
          {
            id: 'a',
            type: 'delay',
            name: 'A',
            parameters: { durationSeconds: 1 },
            execution: { timeoutSeconds: 3600 },
          },
        ],
        edges: [],
        variables: {},
      }),
    );
    const data = await ids.create(t, 'test-data', dataBody());
    const response = await createRun(t, {
      testId: test.id,
      dataSetId: data.id,
      environmentId: 'local-test',
    });
    expect(response.statusCode).toBe(422);
    expect(t.json<Problem>(response).code).toBe('VALIDATION_TARGET_POLICY');
  });
});

describe('snapshot immutability and rerun', () => {
  it('keeps the Run on the definitions it was created with, even after they change or are deleted', async () => {
    const t = await createTestApp();
    const inputs = await seedRunInputs(t);
    const run = t.json<RunSummary>(await createRun(t, inputs));

    await t.request({
      method: 'PUT',
      url: `/api/v1/tests/${inputs.testId}`,
      payload: { ...testBody({ name: 'Changed after run' }), version: 1 },
    });
    await t.request({
      method: 'PUT',
      url: `/api/v1/test-data/${inputs.dataSetId}`,
      payload: { ...dataBody({ data: { order: { id: 'CHANGED' } } }), version: 1 },
    });

    const detail = t.json<RunDetail>(await t.request({ url: `/api/v1/runs/${run.id}` }));
    expect(detail.snapshots.test).toMatchObject({
      version: 1,
      name: 'Order processing happy path',
    });
    expect(detail.snapshots.testData).toMatchObject({
      version: 1,
      data: { order: { id: 'ORD-1' } },
    });
    expect(detail.test).toEqual({ id: inputs.testId, version: 1 });
  });

  it('stores an independent copy: later edits to stored rows cannot leak into the snapshot', async () => {
    const t = await createTestApp();
    const inputs = await seedRunInputs(t);
    const run = t.json<RunSummary>(await createRun(t, inputs));
    const stored = await t.container.infra.runs.getRun(run.id);
    expect(stored?.snapshots.test?.version).toBe(1);

    const again = await t.container.infra.runs.getRun(run.id);
    (again?.snapshots.test as { name: string }).name = 'mutated in memory';
    expect((await t.container.infra.runs.getRun(run.id))?.snapshots.test?.name).toBe(
      'Order processing happy path',
    );
  });

  it('reruns from the original snapshot, not the live definitions', async () => {
    const t = await createTestApp();
    const inputs = await seedRunInputs(t);
    const first = t.json<RunSummary>(
      await createRun(t, { ...inputs, variableOverrides: { orderId: 'ORD-5' } }),
    );
    await t.container.infra.runs.transitionRun(first.id, {
      from: 'Queued',
      to: 'Running',
      at: '2026-01-01T00:00:00.000Z',
    });
    await t.container.infra.runs.transitionRun(first.id, {
      from: 'Running',
      to: 'Failed',
      at: '2026-01-01T00:00:01.000Z',
    });

    await t.request({
      method: 'PUT',
      url: `/api/v1/tests/${inputs.testId}`,
      payload: { ...testBody({ name: 'Edited' }), version: 1 },
    });
    await t.request({ method: 'DELETE', url: `/api/v1/test-data/${inputs.dataSetId}` });

    const response = await t.request({ method: 'POST', url: `/api/v1/runs/${first.id}/rerun` });
    expect(response.statusCode).toBe(202);
    const rerun = t.json<RunSummary>(response);
    expect(rerun).toMatchObject({
      status: 'Queued',
      rerunOfRunId: first.id,
      variableOverrides: { orderId: 'ORD-5' },
      test: { version: 1 },
    });
    expect(rerun.id).not.toBe(first.id);
    expect(rerun.startedAt).toBeUndefined();

    const detail = t.json<RunDetail>(await t.request({ url: `/api/v1/runs/${rerun.id}` }));
    expect(detail.snapshots.test?.name).toBe('Order processing happy path');
    expect(detail.snapshots.testData?.data).toEqual({
      order: { id: 'ORD-1', customerId: 'CUS-1' },
    });
    expect(rowCount(t, 'jobs')).toBe(2);
  });

  it('refuses to rerun active or unknown Runs', async () => {
    const t = await createTestApp();
    const run = t.json<RunSummary>(await createRun(t, await seedRunInputs(t)));
    const active = await t.request({ method: 'POST', url: `/api/v1/runs/${run.id}/rerun` });
    expect(active.statusCode).toBe(409);
    expect(
      (await t.request({ method: 'POST', url: '/api/v1/runs/unknown/rerun' })).statusCode,
    ).toBe(404);
  });
});

describe('cancel', () => {
  it('cancels a queued Run immediately and cancels its job', async () => {
    const t = await createTestApp();
    const run = t.json<RunSummary>(await createRun(t, await seedRunInputs(t)));
    const response = await t.request({ method: 'POST', url: `/api/v1/runs/${run.id}/cancel` });

    expect(response.statusCode).toBe(202);
    expect(t.json<RunSummary>(response)).toMatchObject({ status: 'Cancelled' });
    expect(t.json<RunSummary>(response).cancelRequestedAt).toBeDefined();
    expect(t.container.infra.db.prepare('SELECT status FROM jobs').get()).toEqual({
      status: 'cancelled',
    });
    expect(await t.container.infra.jobs.claim({ workerId: 'w', leaseMs: 1000 })).toBeUndefined();
    const events = await t.container.infra.events.listSince(run.id);
    expect(events.map((e) => (e.data as { status: string }).status)).toEqual([
      'Queued',
      'Cancelled',
    ]);
  });

  it('asks a running Run to stop cooperatively and is idempotent', async () => {
    const t = await createTestApp();
    const run = t.json<RunSummary>(await createRun(t, await seedRunInputs(t)));
    await t.container.infra.runs.transitionRun(run.id, {
      from: 'Queued',
      to: 'Running',
      at: '2026-01-01T00:00:00.000Z',
    });

    const first = await t.request({ method: 'POST', url: `/api/v1/runs/${run.id}/cancel` });
    expect(t.json<RunSummary>(first).status).toBe('Cancelling');
    const second = await t.request({ method: 'POST', url: `/api/v1/runs/${run.id}/cancel` });
    expect(second.statusCode).toBe(202);
    expect(t.json<RunSummary>(second).status).toBe('Cancelling');
    expect(
      (await t.container.infra.events.listSince(run.id)).filter(
        (e) => (e.data as { status: string }).status === 'Cancelling',
      ),
    ).toHaveLength(1);
  });

  it('rejects finished and unknown Runs', async () => {
    const t = await createTestApp();
    const run = t.json<RunSummary>(await createRun(t, await seedRunInputs(t)));
    await t.container.infra.runs.transitionRun(run.id, {
      from: 'Queued',
      to: 'Running',
      at: '2026-01-01T00:00:00.000Z',
    });
    await t.container.infra.runs.transitionRun(run.id, {
      from: 'Running',
      to: 'Succeeded',
      at: '2026-01-01T00:00:01.000Z',
    });

    const finished = await t.request({ method: 'POST', url: `/api/v1/runs/${run.id}/cancel` });
    expect(finished.statusCode).toBe(409);
    expect(
      (await t.request({ method: 'POST', url: '/api/v1/runs/unknown/cancel' })).statusCode,
    ).toBe(404);
  });
});

describe('Run history and detail', () => {
  it('lists newest first with filters, and returns detail with Step runs', async () => {
    const t = await createTestApp();
    const inputs = await seedRunInputs(t);
    const first = t.json<RunSummary>(await createRun(t, inputs));
    const second = t.json<RunSummary>(await createRun(t, inputs));
    await t.container.infra.runs.transitionRun(first.id, {
      from: 'Queued',
      to: 'Running',
      at: '2026-01-01T00:00:00.000Z',
    });

    const all = t.json<{ items: RunSummary[] }>(await t.request({ url: '/api/v1/runs' })).items;
    expect(all.map((r) => r.id).sort()).toEqual([first.id, second.id].sort());
    expect(JSON.stringify(all)).not.toContain('snapshots');

    expect(
      t
        .json<{ items: RunSummary[] }>(await t.request({ url: '/api/v1/runs?status=Running' }))
        .items.map((r) => r.id),
    ).toEqual([first.id]);
    expect(
      t.json<{ items: RunSummary[] }>(
        await t.request({ url: `/api/v1/runs?testId=${inputs.testId}&limit=1` }),
      ).items,
    ).toHaveLength(1);
    expect((await t.request({ url: '/api/v1/runs?status=Bogus' })).statusCode).toBe(400);
    expect((await t.request({ url: '/api/v1/runs?limit=1000' })).statusCode).toBe(422);
    expect((await t.request({ url: '/api/v1/runs?limit=abc' })).statusCode).toBe(400);

    await t.container.infra.runs.createStepRun({
      id: 'step-1',
      runId: first.id,
      nodeId: 'wait',
      attempt: 1,
      status: 'Queued',
      logs: [],
      artifacts: [],
    });
    const detail = t.json<RunDetail>(await t.request({ url: `/api/v1/runs/${first.id}` }));
    expect(detail.stepRuns.map((s) => s.id)).toEqual(['step-1']);
    expect(detail.snapshots.environment).toEqual({
      id: 'local-test',
      name: 'Local test environment',
      classification: 'TEST',
      suiteConcurrencyLimit: 1,
      targets: [{ name: 'example-api', kind: 'http' }],
    });

    const step = t.json<StepRun>(await t.request({ url: `/api/v1/runs/${first.id}/steps/step-1` }));
    expect(step.nodeId).toBe('wait');
    expect((await t.request({ url: `/api/v1/runs/${second.id}/steps/step-1` })).statusCode).toBe(
      404,
    );
    expect((await t.request({ url: '/api/v1/runs/unknown' })).statusCode).toBe(404);
  });

  it('never exposes environment target details, secret references, or secret values', async () => {
    const t = await createTestApp();
    const run = t.json<RunSummary>(await createRun(t, await seedRunInputs(t)));
    await t.container.infra.runs.createStepRun({
      id: 'step-1',
      runId: run.id,
      nodeId: 'wait',
      attempt: 1,
      status: 'Failed',
      resolvedInput: { header: `Bearer ${SECRET}` },
      outputPreview: { echoed: SECRET },
      error: { code: 'TARGET_REQUEST', message: `upstream rejected ${SECRET}` },
      logs: [{ timestamp: '2026-01-01T00:00:00.000Z', level: 'error', message: `used ${SECRET}` }],
      artifacts: [],
    });

    for (const url of [
      `/api/v1/runs/${run.id}`,
      `/api/v1/runs/${run.id}/steps/step-1`,
      '/api/v1/runs',
      '/api/v1/environments',
    ]) {
      const response = await t.request({ url });
      expect(response.body, url).not.toContain(SECRET);
      expect(response.body, url).not.toContain('example.invalid');
      expect(response.body, url).not.toContain('api-key');
    }
    const step = await t.request({ url: `/api/v1/runs/${run.id}/steps/step-1` });
    expect(step.body).toContain('REDACTED');
  });
});
