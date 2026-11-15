import { afterEach, describe, expect, it } from 'vitest';
import { cleanupAll, createTestApp, dataBody, ids, testBody, type TestApp } from './helpers.js';

afterEach(cleanupAll);

type Problem = {
  type: string;
  title: string;
  status: number;
  code: string;
  requestId: string;
  instance: string;
  detail?: string;
  errors?: { path: string; message: string; keyword?: string }[];
};

const post = (t: TestApp, url: string, payload: unknown) =>
  t.request({ method: 'POST', url, payload: payload as object });
const put = (t: TestApp, url: string, payload: unknown) =>
  t.request({ method: 'PUT', url, payload: payload as object });

describe('Tests: create, read, list', () => {
  it('creates a versioned Test with server-assigned id and metadata', async () => {
    const t = await createTestApp();
    const response = await post(t, '/api/v1/tests', testBody());
    expect(response.statusCode).toBe(201);

    const test = t.json<{
      id: string;
      version: number;
      schemaVersion: number;
      metadata: { createdBy: string };
    }>(response);
    // A Test authored without positions is a legacy-style flow: presented in the current schema
    // with position sequencing off, its stored edges authoritative.
    expect(test).toMatchObject({
      version: 1,
      schemaVersion: 2,
      editor: { layoutDirection: 'vertical', autoSequenceFromPosition: false },
      metadata: { createdBy: 'local-dev-user' },
    });
    expect(response.headers.location).toBe(`/api/v1/tests/${test.id}`);
    expect(response.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);

    const fetched = await t.request({ url: `/api/v1/tests/${test.id}` });
    expect(fetched.json()).toEqual(test);
  });

  it('lists, filters, and reports versions', async () => {
    const t = await createTestApp();
    const a = await ids.create(t, 'tests', testBody({ name: 'Alpha', tags: ['smoke'] }));
    await ids.create(t, 'tests', testBody({ name: 'Beta', tags: ['regression'] }));

    const all = t.json<{ items: { name: string }[] }>(await t.request({ url: '/api/v1/tests' }));
    expect(all.items.map((i) => i.name)).toEqual(['Alpha', 'Beta']);
    expect(
      t.json<{ items: unknown[] }>(await t.request({ url: '/api/v1/tests?tag=smoke' })).items,
    ).toHaveLength(1);
    expect(
      t.json<{ items: unknown[] }>(await t.request({ url: '/api/v1/tests?search=bet' })).items,
    ).toHaveLength(1);

    const versions = t.json<{ items: { version: number }[] }>(
      await t.request({ url: `/api/v1/tests/${a.id}/versions` }),
    );
    expect(versions.items.map((v) => v.version)).toEqual([1]);
  });

  it('returns RFC 7807 problems for unknown resources and malformed ids', async () => {
    const t = await createTestApp();
    const missing = await t.request({
      url: '/api/v1/tests/does-not-exist',
      headers: { 'x-request-id': 'trace-123' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).toContain('application/problem+json');
    expect(missing.headers['x-request-id']).toBe('trace-123');
    expect(t.json<Problem>(missing)).toMatchObject({
      type: 'https://test-platform.dev/problems/validation-not-found',
      title: 'Resource not found',
      status: 404,
      code: 'VALIDATION_NOT_FOUND',
      instance: '/api/v1/tests/does-not-exist',
      requestId: 'trace-123',
    });

    const malformed = await t.request({ url: '/api/v1/tests/..%2F..%2Fetc' });
    expect(malformed.statusCode).toBe(400);
    expect(t.json<Problem>(malformed).code).toBe('VALIDATION_SCHEMA');

    expect((await t.request({ url: '/api/v1/nope' })).statusCode).toBe(404);
  });

  it('generates a request id when none, or an unsafe one, is supplied', async () => {
    const t = await createTestApp();
    const generated = await t.request({ url: '/health/live' });
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const unsafe = await t.request({
      url: '/health/live',
      headers: { 'x-request-id': 'bad id\nwith newline' },
    });
    expect(unsafe.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('Tests: validation failures are rejected before saving', () => {
  const rejected = async (overrides: Record<string, unknown>) => {
    const t = await createTestApp();
    const response = await post(t, '/api/v1/tests', testBody(overrides));
    const list = t.json<{ items: unknown[] }>(await t.request({ url: '/api/v1/tests' }));
    return { t, response, problem: t.json<Problem>(response), saved: list.items.length };
  };

  it('rejects cycles, disconnected and branching flows with VALIDATION_FLOW', async () => {
    const cycle = await rejected({
      edges: [
        { from: 'wait', to: 'shape' },
        { from: 'shape', to: 'verify' },
        { from: 'verify', to: 'wait' },
      ],
    });
    expect(cycle.response.statusCode).toBe(422);
    expect(cycle.problem).toMatchObject({ code: 'VALIDATION_FLOW' });
    expect(cycle.problem.errors?.map((e) => e.keyword)).toContain('FLOW_CYCLE');
    expect(cycle.saved).toBe(0);

    const fanOut = await rejected({
      edges: [
        { from: 'wait', to: 'shape' },
        { from: 'wait', to: 'verify' },
      ],
    });
    expect(fanOut.problem.errors?.map((e) => e.keyword)).toEqual(
      expect.arrayContaining(['FLOW_FAN_OUT']),
    );
  });

  it('rejects unknown Step types, bad expressions, and misordered step references', async () => {
    const unknownType = await rejected({
      nodes: [{ id: 'a', type: 'queue.purge', name: 'A', parameters: {} }],
      edges: [],
      variables: {},
    });
    expect(unknownType.problem.errors?.map((e) => e.keyword)).toContain('FLOW_UNKNOWN_STEP_TYPE');

    const badExpression = await rejected({ variables: { v: '{{process.env.HOME}}' } });
    expect(badExpression.problem.code).toBe('VALIDATION_EXPRESSION');

    const later = testBody();
    (later.nodes[0] as { parameters: object }).parameters = {
      durationSeconds: '{{steps.verify.output.x}}',
    };
    const reference = await rejected({ nodes: later.nodes });
    expect(reference.problem.errors?.[0]?.message).toContain('does not precede');
  });

  it('rejects missing or invalid Step configuration', async () => {
    const missing = await rejected({
      nodes: [{ id: 'a', type: 'delay', name: 'A', parameters: {} }],
      edges: [],
      variables: {},
    });
    expect(missing.problem.errors).toEqual([
      expect.objectContaining({ path: '/nodes/0/parameters/durationSeconds' }),
    ]);

    const invalid = await rejected({
      nodes: [
        { id: 'a', type: 'assert', name: 'A', parameters: { actual: 1, operator: 'equals' } },
      ],
      edges: [],
      variables: {},
    });
    expect(invalid.problem.errors?.[0]?.path).toBe('/nodes/0/parameters/expected');

    const partlyDynamic = await rejected({
      nodes: [
        { id: 'a', type: 'assert', name: 'A', parameters: { actual: '{{testData.x}}', bogus: 1 } },
      ],
      edges: [],
      variables: {},
    });
    expect(partlyDynamic.problem.errors?.map((e) => e.path)).toEqual(
      expect.arrayContaining(['/nodes/0/parameters/operator', '/nodes/0/parameters/bogus']),
    );
  });

  it('rejects schema violations, unknown properties, and client-assigned server fields', async () => {
    expect((await rejected({ nodes: [], edges: [] })).problem).toMatchObject({
      code: 'VALIDATION_SCHEMA',
      status: 422,
    });
    expect((await rejected({ surprise: true })).problem.code).toBe('VALIDATION_SCHEMA');

    const t = await createTestApp();
    const withId = await post(t, '/api/v1/tests', {
      ...testBody(),
      id: '01JTEST8M2B5D4KQ7XNH3WV9ZA',
    });
    expect(withId.statusCode).toBe(422);
    expect(t.json<Problem>(withId).errors?.[0]).toMatchObject({ path: '/id', keyword: 'readOnly' });
    const withMetadata = await post(t, '/api/v1/tests', {
      ...testBody(),
      metadata: { createdAt: 'x', createdBy: 'me' },
    });
    expect(withMetadata.statusCode).toBe(422);
  });

  it('reports malformed JSON, wrong media type, and oversized bodies as problems', async () => {
    const t = await createTestApp({ env: { TEST_PLATFORM_API_BODY_LIMIT_BYTES: '2048' } });
    const malformed = await t.request({
      method: 'POST',
      url: '/api/v1/tests',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(malformed.statusCode).toBe(400);
    expect(t.json<Problem>(malformed).code).toBe('VALIDATION_SCHEMA');

    const wrongType = await t.request({
      method: 'POST',
      url: '/api/v1/tests',
      headers: { 'content-type': 'text/plain' },
      payload: 'hello',
    });
    expect(wrongType.statusCode).toBe(415);

    const tooLarge = await post(t, '/api/v1/tests', testBody({ description: 'x'.repeat(4000) }));
    expect(tooLarge.statusCode).toBe(413);
    expect(t.json<Problem>(tooLarge)).toMatchObject({ status: 413, code: 'VALIDATION_SCHEMA' });

    const poisoned = await t.request({
      method: 'POST',
      url: '/api/v1/tests',
      headers: { 'content-type': 'application/json' },
      payload: '{"__proto__":{"admin":true},"name":"x"}',
    });
    expect(poisoned.statusCode).toBe(400);
  });

  it('never echoes registered secret values in error responses', async () => {
    const t = await createTestApp({ env: { TEST_PLATFORM_SECRET_OTHER: 'sup3rsecretvalue' } });
    const response = await post(
      t,
      '/api/v1/tests',
      testBody({
        nodes: [{ id: 'a', type: 'sup3rsecretvalue', name: 'A', parameters: {} }],
        edges: [],
        variables: {},
      }),
    );
    expect(response.statusCode).toBe(422);
    expect(response.body).not.toContain('sup3rsecretvalue');
    expect(response.body).toContain('REDACTED');
  });
});

describe('Tests: versioned updates and deletion', () => {
  it('saves a new version and keeps the previous one readable', async () => {
    const t = await createTestApp();
    const created = await ids.create(t, 'tests', testBody());
    const updated = await put(t, `/api/v1/tests/${created.id}`, {
      ...testBody({ name: 'Renamed' }),
      version: 1,
    });
    expect(updated.statusCode).toBe(200);
    expect(t.json<{ version: number; name: string }>(updated)).toMatchObject({
      version: 2,
      name: 'Renamed',
    });

    expect(
      t.json<{ name: string }>(await t.request({ url: `/api/v1/tests/${created.id}?version=1` }))
        .name,
    ).toBe('Order processing happy path');
    expect(
      t.json<{ name: string }>(await t.request({ url: `/api/v1/tests/${created.id}` })).name,
    ).toBe('Renamed');
    expect((await t.request({ url: `/api/v1/tests/${created.id}?version=9` })).statusCode).toBe(
      404,
    );
    expect(
      t.json<{ items: unknown[] }>(await t.request({ url: `/api/v1/tests/${created.id}/versions` }))
        .items,
    ).toHaveLength(2);
  });

  it('rejects stale and missing versions with 409 / 422', async () => {
    const t = await createTestApp();
    const created = await ids.create(t, 'tests', testBody());
    await put(t, `/api/v1/tests/${created.id}`, { ...testBody(), version: 1 });

    const stale = await put(t, `/api/v1/tests/${created.id}`, { ...testBody(), version: 1 });
    expect(stale.statusCode).toBe(409);
    expect(t.json<Problem>(stale).code).toBe('VALIDATION_CONFLICT');

    const missingVersion = await put(t, `/api/v1/tests/${created.id}`, testBody());
    expect(missingVersion.statusCode).toBe(422);

    const otherId = await put(t, `/api/v1/tests/${created.id}`, {
      ...testBody(),
      version: 2,
      id: '01JTEST8M2B5D4KQ7XNH3WV9ZA',
    });
    expect(otherId.statusCode).toBe(422);
    expect((await put(t, '/api/v1/tests/unknown', { ...testBody(), version: 1 })).statusCode).toBe(
      404,
    );
  });

  it('rejects an invalid update without changing the stored Test', async () => {
    const t = await createTestApp();
    const created = await ids.create(t, 'tests', testBody());
    const response = await put(t, `/api/v1/tests/${created.id}`, {
      ...testBody({ edges: [] }),
      version: 1,
    });
    expect(response.statusCode).toBe(422);
    expect(
      t.json<{ version: number }>(await t.request({ url: `/api/v1/tests/${created.id}` })).version,
    ).toBe(1);
  });

  it('deletes unreferenced Tests and records audit events', async () => {
    const t = await createTestApp();
    const created = await ids.create(t, 'tests', testBody());
    expect(
      (await t.request({ method: 'DELETE', url: `/api/v1/tests/${created.id}` })).statusCode,
    ).toBe(204);
    expect((await t.request({ url: `/api/v1/tests/${created.id}` })).statusCode).toBe(404);
    expect(
      (await t.request({ method: 'DELETE', url: `/api/v1/tests/${created.id}` })).statusCode,
    ).toBe(404);

    const actions = (
      t.container.infra.db.prepare('SELECT action, actor FROM audit_events ORDER BY id').all() as {
        action: string;
        actor: string;
      }[]
    ).map((r) => `${r.actor}:${r.action}`);
    expect(actions).toEqual(['local-dev-user:test.create', 'local-dev-user:test.delete']);
  });
});

describe('Test Data and Suites', () => {
  it('manages versioned Test Data', async () => {
    const t = await createTestApp();
    const created = await ids.create(t, 'test-data', dataBody());
    const updated = await put(t, `/api/v1/test-data/${created.id}`, {
      ...dataBody({ data: { order: { id: 'ORD-2' } } }),
      version: 1,
    });
    expect(t.json<{ version: number; data: { order: { id: string } } }>(updated)).toMatchObject({
      version: 2,
      data: { order: { id: 'ORD-2' } },
    });
    const unknown = await post(
      t,
      '/api/v1/test-data',
      dataBody({ data: { order: { id: 'ORD-{{ global.nope }}' } } }),
    );
    expect(unknown.statusCode).toBe(422);
    expect(unknown.body).toContain('/data/order/id');
    expect(
      (
        await post(
          t,
          '/api/v1/test-data',
          dataBody({ data: { order: { id: 'ORD-{{ global.runNumber }}' } } }),
        )
      ).statusCode,
    ).toBe(201);
    expect((await post(t, '/api/v1/test-data', { name: 'No data' })).statusCode).toBe(422);
    expect(
      t.json<{ items: unknown[] }>(await t.request({ url: '/api/v1/test-data' })).items,
    ).toHaveLength(2);
    expect(
      (await t.request({ method: 'DELETE', url: `/api/v1/test-data/${created.id}` })).statusCode,
    ).toBe(204);
  });

  it('creates, reads, updates, and lists Suites, validating references', async () => {
    const t = await createTestApp();
    const test = await ids.create(t, 'tests', testBody());
    const data = await ids.create(t, 'test-data', dataBody());

    const dangling = await post(t, '/api/v1/suites', {
      name: 'Bad',
      items: [{ testId: '01JTEST8M2B5D4KQ7XNH3WV9ZA', dataSetId: data.id }],
    });
    expect(dangling.statusCode).toBe(422);
    expect(t.json<Problem>(dangling)).toMatchObject({ code: 'VALIDATION_REFERENCE' });

    const suite = await ids.create(t, 'suites', {
      name: 'Smoke',
      items: [{ testId: test.id, dataSetId: data.id }],
    });
    const updated = await put(t, `/api/v1/suites/${suite.id}`, {
      name: 'Smoke v2',
      items: [{ testId: test.id, dataSetId: data.id, testVersion: 1 }],
      version: 1,
    });
    expect(t.json<{ version: number; name: string }>(updated)).toMatchObject({
      version: 2,
      name: 'Smoke v2',
    });
    expect(
      t.json<{ items: unknown[] }>(await t.request({ url: '/api/v1/suites' })).items,
    ).toHaveLength(1);
    expect((await t.request({ url: `/api/v1/suites/${suite.id}` })).statusCode).toBe(200);
  });

  it('protects assets used by Suites from deletion and exposes no Suite delete endpoint', async () => {
    const t = await createTestApp();
    const test = await ids.create(t, 'tests', testBody());
    const data = await ids.create(t, 'test-data', dataBody());
    const suite = await ids.create(t, 'suites', {
      name: 'Smoke',
      items: [{ testId: test.id, dataSetId: data.id }],
    });

    const blockedTest = await t.request({ method: 'DELETE', url: `/api/v1/tests/${test.id}` });
    expect(blockedTest.statusCode).toBe(409);
    expect(
      (await t.request({ method: 'DELETE', url: `/api/v1/test-data/${data.id}` })).statusCode,
    ).toBe(409);
    expect(
      (await t.request({ method: 'DELETE', url: `/api/v1/suites/${suite.id}` })).statusCode,
    ).toBe(404);
  });
});
