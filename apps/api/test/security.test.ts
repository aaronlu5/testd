import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupAll, createTestApp, ENVIRONMENTS, SECRET, testBody } from './helpers.js';

afterEach(cleanupAll);

describe('API guards', () => {
  it('rejects non-loopback Host headers (DNS rebinding) on the API but not on health', async () => {
    const t = await createTestApp();
    const response = await t.request({ url: '/api/v1/tests', headers: { host: 'evil.example' } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'AUTH_FORBIDDEN' });

    for (const host of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000', 'localhost']) {
      expect((await t.request({ url: '/api/v1/tests', headers: { host } })).statusCode, host).toBe(
        200,
      );
    }
    expect(
      (await t.request({ url: '/health/live', headers: { host: 'service.internal' } })).statusCode,
    ).toBe(200);
  });

  it('rejects state-changing requests from unapproved origins but allows configured ones', async () => {
    const t = await createTestApp();
    const evil = await t.request({
      method: 'POST',
      url: '/api/v1/tests',
      headers: { origin: 'https://evil.example' },
      payload: testBody(),
    });
    expect(evil.statusCode).toBe(403);
    expect((await t.request({ url: '/api/v1/tests' })).json()).toEqual({ items: [] });

    const allowed = await t.request({
      method: 'POST',
      url: '/api/v1/tests',
      headers: { origin: 'http://localhost:5173' },
      payload: testBody(),
    });
    expect(allowed.statusCode).toBe(201);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(allowed.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('does not grant CORS access to other origins and answers preflight for approved ones', async () => {
    const t = await createTestApp();
    const other = await t.request({
      url: '/api/v1/tests',
      headers: { origin: 'https://evil.example' },
    });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();

    const preflight = await t.request({
      method: 'OPTIONS',
      url: '/api/v1/runs',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-request-id',
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(preflight.headers['access-control-allow-methods']).toContain('POST');
  });

  it('adds defensive headers and forbids caching of API responses', async () => {
    const t = await createTestApp();
    const response = await t.request({ url: '/api/v1/step-types' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('uses the configured local-dev identity for actors', async () => {
    const t = await createTestApp({ env: { TEST_PLATFORM_DEV_USER: 'ada' } });
    const created = await t.request({ method: 'POST', url: '/api/v1/tests', payload: testBody() });
    expect(created.json()).toMatchObject({ metadata: { createdBy: 'ada' } });
  });

  it('delegates to a replaceable authentication provider', async () => {
    const t = await createTestApp();
    const { buildApp } = await import('../src/app.js');
    const guarded = await buildApp({
      config: t.config,
      logger: false,
      container: {
        ...t.container,
        auth: {
          authenticate: async () => {
            throw new (await import('@test-platform/core')).PlatformError(
              'AUTH_CREDENTIAL',
              'Sign in required.',
            );
          },
        },
      },
    });
    const response = await guarded.inject({ url: '/api/v1/tests' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'AUTH_CREDENTIAL' });
    expect((await guarded.inject({ url: '/health/live' })).statusCode).toBe(200);
    await guarded.close();
  });
});

describe('logging and redaction', () => {
  it('logs structured requests with the request id but never headers, query strings, or secrets', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write: (chunk, _encoding, callback) => (lines.push(String(chunk)), callback()),
    });
    const t = await createTestApp({ logStream: stream, env: { TEST_PLATFORM_LOG_LEVEL: 'info' } });

    await t.request({
      url: `/api/v1/tests?search=${SECRET}`,
      headers: {
        authorization: `Bearer ${SECRET}`,
        cookie: `session=${SECRET}`,
        'x-request-id': 'req-77',
      },
    });

    const output = lines.join('');
    expect(output).toContain('req-77');
    expect(output).not.toContain(SECRET);
  });

  it('keeps server-side error details out of responses while logging them without secrets', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write: (chunk, _encoding, callback) => (lines.push(String(chunk)), callback()),
    });
    const t = await createTestApp({ logStream: stream, env: { TEST_PLATFORM_LOG_LEVEL: 'info' } });
    t.container.infra.runs.listRuns = async () => {
      throw new Error(`database exploded near ${SECRET} at C:\\private\\path`);
    };

    const response = await t.request({ url: '/api/v1/runs' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: 'SYSTEM_INTERNAL', status: 500 });
    expect(response.body).not.toContain('exploded');
    expect(response.body).not.toContain('private');
    expect(lines.join('')).not.toContain(SECRET);
    expect(lines.join('')).toContain('exploded');
  });

  it('keeps the Environment configuration out of every API response', async () => {
    const t = await createTestApp();
    const secretRef = ENVIRONMENTS.environments[0]?.targets['example-api']?.secretRef as string;
    for (const url of ['/api/v1/environments', '/api/v1/step-types', '/health/ready']) {
      const body = (await t.request({ url })).body;
      expect(body, url).not.toContain(secretRef);
      expect(body, url).not.toContain('https://example.invalid');
    }
  });
});
