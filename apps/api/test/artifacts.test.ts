import { afterEach, describe, expect, it } from 'vitest';
import type { Artifact, RunSummary } from '@test-platform/contracts';
import { cleanupAll, createTestApp, seedRunInputs, type TestApp } from './helpers.js';

afterEach(cleanupAll);

const setup = async () => {
  const t = await createTestApp();
  const run = t.json<RunSummary>(
    await t.request({ method: 'POST', url: '/api/v1/runs', payload: await seedRunInputs(t) }),
  );
  await t.container.infra.runs.createStepRun({
    id: 'step-1',
    runId: run.id,
    nodeId: 'wait',
    attempt: 1,
    status: 'Running',
    logs: [],
    artifacts: [],
  });
  const write = (content: string | Uint8Array, contentType: string): Promise<Artifact> =>
    t.container.infra.artifacts.write({ runId: run.id, stepRunId: 'step-1', content, contentType });
  return { t, run, write };
};

describe('artifacts', () => {
  it('returns metadata without any filesystem path', async () => {
    const { t, run, write } = await setup();
    const artifact = await write('{"a":1}', 'application/json');
    const response = await t.request({ url: `/api/v1/artifacts/${artifact.id}/metadata` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(artifact);
    expect(Object.keys(response.json() as object).sort()).toEqual([
      'contentType',
      'createdAt',
      'id',
      'runId',
      'sha256',
      'sizeBytes',
      'stepRunId',
    ]);
    expect(response.body).not.toContain(t.dir);
    expect((response.json() as Artifact).runId).toBe(run.id);
  });

  it('streams safe types inline with hardening headers', async () => {
    const { t, write } = await setup();
    const artifact = await write('{"a":1}', 'application/json; charset=utf-8');
    const response = await t.request({ url: `/api/v1/artifacts/${artifact.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"a":1}');
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.headers['content-disposition']).toBe('inline');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['cache-control']).toContain('no-store');
  });

  it('forces untrusted or unusual content types to a download', async () => {
    const { t, write } = await setup();
    for (const type of [
      'text/html',
      'image/svg+xml',
      'application/x-evil',
      'text/plain\r\nSet-Cookie: x=1',
    ]) {
      const artifact = await write('<script>alert(1)</script>', type);
      const response = await t.request({ url: `/api/v1/artifacts/${artifact.id}` });
      expect(response.headers['content-type'], type).toBe('application/octet-stream');
      expect(response.headers['content-disposition'], type).toBe(
        `attachment; filename="artifact-${artifact.id}"`,
      );
      expect(response.headers['set-cookie']).toBeUndefined();
    }
  });

  it('answers 404 for unknown artifacts and 400 for malformed ids', async () => {
    const { t } = await setup();
    expect((await t.request({ url: '/api/v1/artifacts/does-not-exist' })).statusCode).toBe(404);
    expect((await t.request({ url: '/api/v1/artifacts/does-not-exist/metadata' })).statusCode).toBe(
      404,
    );
    expect((await t.request({ url: '/api/v1/artifacts/..%2F..%2Fsecret' })).statusCode).toBe(400);
  });

  it('refuses to serve content that no longer matches its checksum', async () => {
    const { t, write } = await setup();
    const artifact = await write('original', 'text/plain');
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await writeFile(
      join(t.dir, 'runtime', 'artifacts', artifact.runId, artifact.stepRunId, artifact.id),
      'tampered',
    );
    const response = await t.request({ url: `/api/v1/artifacts/${artifact.id}` });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: 'EXECUTION_ARTIFACT' });
    expect(response.body).not.toContain('tampered');
  });

  it('does not serve artifacts whose Run no longer exists', async () => {
    const { t, run, write } = await setup();
    const artifact = await write('x', 'text/plain');
    t.container.infra.db.exec('PRAGMA foreign_keys = OFF');
    t.container.infra.db.prepare('DELETE FROM runs WHERE id = ?').run(run.id);
    expect((await t.request({ url: `/api/v1/artifacts/${artifact.id}/metadata` })).statusCode).toBe(
      404,
    );
  });
});

export type { TestApp };
