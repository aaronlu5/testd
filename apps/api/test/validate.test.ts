import { afterEach, describe, expect, it } from 'vitest';
import { cleanupAll, createTestApp, ids, testBody, type TestApp } from './helpers.js';

afterEach(cleanupAll);

type Report = {
  valid: boolean;
  issues: { path: string; message: string; keyword?: string }[];
  order: string[];
};
type Problem = { code: string };

const validate = async (t: TestApp, id: string, body?: unknown) => {
  const response = await t.request({
    method: 'POST',
    url: `/api/v1/tests/${id}/validate`,
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { response, report: response.json() as Report };
};

describe('POST /tests/{id}/validate', () => {
  it('reports a valid stored Test with its execution order, saving nothing', async () => {
    const t = await createTestApp();
    const { id } = await ids.create(t, 'tests', testBody());
    const { response, report } = await validate(t, id, { environmentId: 'local-test' });
    expect(response.statusCode).toBe(200);
    expect(report).toMatchObject({ valid: true, issues: [], order: ['wait', 'shape', 'verify'] });
  });

  it('works without a body', async () => {
    const t = await createTestApp();
    const { id } = await ids.create(t, 'tests', testBody());
    expect((await validate(t, id)).report.valid).toBe(true);
  });

  it('validates an unsaved draft and leaves the stored Test untouched', async () => {
    const t = await createTestApp();
    const { id } = await ids.create(t, 'tests', testBody());
    const draft = testBody({
      edges: [
        { from: 'wait', to: 'shape' },
        { from: 'shape', to: 'verify' },
        { from: 'verify', to: 'wait' },
      ],
    });
    const { report } = await validate(t, id, { test: draft });
    expect(report.valid).toBe(false);
    expect(report.issues.map((i) => i.keyword)).toContain('FLOW_CYCLE');
    expect(
      t.json<{ version: number }>(await t.request({ url: `/api/v1/tests/${id}` })).version,
    ).toBe(1);
  });

  it('ignores server-owned fields in drafts rather than letting them change identity', async () => {
    const t = await createTestApp();
    const { id } = await ids.create(t, 'tests', testBody());
    const { report } = await validate(t, id, {
      test: { ...testBody(), id: '01JTEST8M2B5D4KQ7XNH3WV9ZA', version: 99 },
    });
    expect(report.valid).toBe(true);
  });

  it('enforces the Environment target policy', async () => {
    const t = await createTestApp();
    const withTarget = (parameters: Record<string, unknown>, execution?: Record<string, unknown>) =>
      testBody({
        nodes: [
          {
            id: 'a',
            type: 'delay',
            name: 'A',
            parameters: { durationSeconds: 1, ...parameters },
            ...(execution ? { execution } : {}),
          },
        ],
        edges: [],
        variables: {},
      });
    const { id } = await ids.create(t, 'tests', testBody());

    const configured = await validate(t, id, {
      environmentId: 'local-test',
      test: withTarget({ target: 'example-api' }),
    });
    // `delay` has no `target` parameter, so only the policy outcome matters: the target itself is fine.
    expect(configured.report.issues.every((i) => i.keyword !== 'target-policy')).toBe(true);

    const unknown = await validate(t, id, {
      environmentId: 'local-test',
      test: withTarget({ target: 'prod-api' }),
    });
    expect(unknown.report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: 'target-policy', path: '/nodes/0/parameters/target' }),
      ]),
    );

    const dynamic = await validate(t, id, {
      environmentId: 'local-test',
      test: withTarget({ target: '{{testData.target}}' }),
    });
    expect(dynamic.report.issues.some((i) => i.message.includes('literal target name'))).toBe(true);

    for (const key of ['url', 'connectionString', 'baseUrl', 'endpoint']) {
      const raw = await validate(t, id, {
        environmentId: 'local-test',
        test: withTarget({ [key]: 'https://evil.example' }),
      });
      expect(
        raw.report.issues.some((i) => i.keyword === 'target-policy' && i.path.endsWith(key)),
        key,
      ).toBe(true);
    }

    const limits = await validate(t, id, {
      environmentId: 'local-test',
      test: withTarget({}, { timeoutSeconds: 600, retry: { maxAttempts: 10 } }),
    });
    expect(
      limits.report.issues.filter((i) => i.keyword === 'target-policy').map((i) => i.path),
    ).toEqual(['/nodes/0/execution/timeoutSeconds', '/nodes/0/execution/retry/maxAttempts']);
  });

  it('returns 404 for unknown Tests, 422 for unknown environments, 400 for bad bodies', async () => {
    const t = await createTestApp();
    const { id } = await ids.create(t, 'tests', testBody());
    expect((await validate(t, 'missing')).response.statusCode).toBe(404);

    const unknownEnv = await validate(t, id, { environmentId: 'nowhere' });
    expect(unknownEnv.response.statusCode).toBe(422);
    expect((unknownEnv.response.json() as Problem).code).toBe('VALIDATION_REFERENCE');

    expect((await validate(t, id, { extra: true })).response.statusCode).toBe(422);
  });
});
