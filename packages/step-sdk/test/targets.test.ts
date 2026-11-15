import { describe, expect, it } from 'vitest';
import type {
  ArtifactReference,
  EnvironmentConfig,
  SecretReference,
} from '@test-platform/contracts';
import {
  PlatformError,
  createRedactor,
  createTargetPolicy,
  createTargetResolver,
  isRetryableCode,
  type BlobPort,
  type BlobProperties,
  type HttpTransportRequest,
  type HttpTransportResponse,
  type OutgoingMessage,
  type ServiceBusPort,
  type TargetClients,
} from '@test-platform/core';
import {
  blobDownloadStep,
  blobUploadStep,
  checkTargetStepPolicy,
  executeStep,
  httpRequestStep,
  serviceBusSendStep,
  waitForConditionStep,
  type StepDefinition,
  type StepExecutionContext,
} from '../src/index.js';
import { makeContext, realClock } from './helpers.js';

// Test-only values, shaped like real credentials so masking is exercised.
const SB_KEY = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==';
const SB_CONNECTION = `Endpoint=sb://example.servicebus.windows.net/;SharedAccessKeyName=send;SharedAccessKey=${SB_KEY}`;
const BLOB_KEY = 'YmxvYmtleWJsb2JrZXlibG9ia2V5MTIzNA==';
const BLOB_CONNECTION = `DefaultEndpointsProtocol=https;AccountName=example;AccountKey=${BLOB_KEY};EndpointSuffix=core.windows.net`;
const API_KEY = 'apikey-0123456789abcdef';

const local = (name: string, usage?: SecretReference['usage']): SecretReference => ({
  type: 'secretReference',
  provider: 'localPlainText',
  name,
  ...(usage ? { usage } : {}),
});

const environment: Pick<EnvironmentConfig, 'id' | 'targets'> = {
  id: 'orders-test',
  targets: {
    api: {
      kind: 'http',
      baseUrl: 'https://example.azure-api.net',
      allowedPaths: ['/orders/*', '/health', '/jobs/*'],
      allowedMethods: ['GET', 'POST', 'PUT'],
      authentication: local('api-key', 'apiKey'),
    },
    open: { kind: 'http', baseUrl: 'https://open.example.com', allowedPaths: ['/**'] },
    noCorrelation: {
      kind: 'http',
      baseUrl: 'https://strict.example.com',
      allowedPaths: ['/**'],
      correlationHeaders: false,
    },
    storage: {
      kind: 'azureBlob',
      accountUrl: 'https://example.blob.core.windows.net',
      allowedContainers: ['inbound-orders'],
      allowedBlobPrefixes: ['runs/'],
    },
    storageConn: {
      kind: 'azureBlob',
      accountUrl: 'https://example.blob.core.windows.net',
      allowedContainers: ['inbound-orders'],
      credential: local('blob-conn', 'connectionString'),
    },
    bus: {
      kind: 'azureServiceBus',
      fullyQualifiedNamespace: 'example.servicebus.windows.net',
      allowedEntities: ['order-events'],
      credential: local('bus-conn', 'connectionString'),
    },
    busEntra: {
      kind: 'azureServiceBus',
      fullyQualifiedNamespace: 'example.servicebus.windows.net',
      allowedEntities: ['order-events'],
    },
  },
};

type HttpScript = (request: HttpTransportRequest, call: number) => HttpTransportResponse | Error;

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  statusText: `S${status}`,
  headers: { 'content-type': 'application/json', ...headers },
  body: new TextEncoder().encode(JSON.stringify(body)),
  truncated: false,
});

type Harness = {
  context: Omit<StepExecutionContext, 'logger'>;
  http: HttpTransportRequest[];
  blobUploads: Parameters<BlobPort['upload']>[0][];
  messages: { entity: string; message: OutgoingMessage }[];
  opened: { kind: string; connectionString?: string }[];
  closed: string[];
  artifacts: { content: Uint8Array | string; label?: string }[];
  resolved: SecretReference[];
};

const harness = (
  options: {
    http?: HttpScript;
    blobs?: Map<string, { content: Uint8Array; properties: BlobProperties }>;
    sendError?: unknown;
    uploadError?: unknown;
    secrets?: Record<string, string>;
    context?: Partial<Omit<StepExecutionContext, 'logger'>>;
  } = {},
): Harness => {
  const state: Harness = {
    context: undefined as never,
    http: [],
    blobUploads: [],
    messages: [],
    opened: [],
    closed: [],
    artifacts: [],
    resolved: [],
  };
  const blobs = options.blobs ?? new Map();
  const secrets = options.secrets ?? {
    'api-key': API_KEY,
    'bus-conn': SB_CONNECTION,
    'blob-conn': BLOB_CONNECTION,
  };
  let calls = 0;
  const blobPort: BlobPort = {
    upload: (input) => {
      state.blobUploads.push(input);
      if (options.uploadError) return Promise.reject(options.uploadError);
      const key = `${input.container}/${input.blobName}`;
      if (!input.overwrite && blobs.has(key)) return Promise.resolve({ created: false });
      const properties: BlobProperties = {
        etag: '"0x1"',
        contentLength: input.content.byteLength,
        metadata: input.metadata,
        ...(input.contentType ? { contentType: input.contentType } : {}),
      };
      blobs.set(key, { content: input.content, properties });
      return Promise.resolve({ created: true, properties });
    },
    getProperties: (input) =>
      Promise.resolve(blobs.get(`${input.container}/${input.blobName}`)?.properties),
    download: (input) => {
      const found = blobs.get(`${input.container}/${input.blobName}`);
      if (!found) return Promise.reject(new PlatformError('TARGET_REQUEST', 'not found'));
      if (found.content.byteLength > input.maxBytes)
        return Promise.reject(new PlatformError('TARGET_REQUEST', 'too large'));
      return Promise.resolve(found);
    },
    close: () => {
      state.closed.push('blob');
      return Promise.resolve();
    },
  };
  const busPort: ServiceBusPort = {
    send: (input) => {
      state.messages.push({ entity: input.entity, message: input.message });
      return options.sendError ? Promise.reject(options.sendError) : Promise.resolve();
    },
    peek: () => Promise.resolve([]),
    close: () => {
      state.closed.push('serviceBus');
      return Promise.resolve();
    },
  };
  const clients: TargetClients = {
    http: {
      send: (request) => {
        state.http.push(request);
        const result = options.http?.(request, calls) ?? jsonResponse(200, { ok: true });
        calls += 1;
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
      },
    },
    openBlob: (connection) => {
      state.opened.push({ kind: 'blob', connectionString: connection.connectionString });
      return blobPort;
    },
    openSql: () => {
      throw new Error('sql is not used here');
    },
    openServiceBus: (connection) => {
      state.opened.push({ kind: 'serviceBus', connectionString: connection.connectionString });
      return busPort;
    },
  };
  state.context = makeContext({
    policy: createTargetPolicy(environment),
    targets: createTargetResolver(environment),
    clients,
    secretReferences: {
      resolve: (reference) => {
        state.resolved.push(reference);
        const value = secrets[reference.name];
        return value === undefined
          ? Promise.reject(
              new PlatformError('AUTH_SECRET_UNAVAILABLE', `Secret "${reference.name}" not found.`),
            )
          : Promise.resolve(value);
      },
      checkReadiness: () => Promise.resolve('available'),
      sensitiveValues: () => [],
    },
    artifacts: {
      write: (input) => {
        state.artifacts.push(input);
        const reference: ArtifactReference = {
          id: `artifact-${state.artifacts.length}`,
          contentType: input.contentType,
          sizeBytes:
            typeof input.content === 'string' ? input.content.length : input.content.byteLength,
          ...(input.label ? { label: input.label } : {}),
        };
        return Promise.resolve(reference);
      },
    },
    correlation: { runId: 'run-1', stepRunId: 'step-run-1', nodeId: 'node-a', attempt: 2 },
    ...options.context,
  });
  return state;
};

// What the worker's redactor would know after the secrets were resolved.
const redactor = createRedactor({
  secretValues: () => [SB_CONNECTION, SB_KEY, BLOB_CONNECTION, BLOB_KEY, API_KEY],
});

const run = (
  definition: StepDefinition<never>,
  config: unknown,
  state: Harness,
  timeoutMs = 5000,
) =>
  executeStep(definition as StepDefinition<unknown>, config as never, state.context, {
    timeoutMs,
    redactor,
  });

const failureCode = (outcome: Awaited<ReturnType<typeof run>>): string | undefined =>
  outcome.result.error?.code;

describe('http.request', () => {
  const base = { target: 'api', path: '/orders/42' };

  it('sends a relative path with target credentials and correlation headers', async () => {
    const state = harness({ http: () => jsonResponse(200, { id: 42 }) });
    const outcome = await run(httpRequestStep as never, base, state);
    expect(outcome.result.status).toBe('Succeeded');
    const [request] = state.http;
    expect(request?.url).toBe('https://example.azure-api.net/orders/42');
    expect(request?.method).toBe('GET');
    expect(request?.headers['ocp-apim-subscription-key']).toBe(API_KEY);
    expect(request?.headers['x-correlation-id']).toBe('run-1');
    expect(request?.headers['x-test-platform-step-run-id']).toBe('step-run-1');
    expect(request?.headers['x-test-platform-attempt']).toBe('2');
    expect(outcome.result.output).toMatchObject({
      status: 200,
      body: { id: 42 },
      bodyEncoding: 'json',
    });
  });

  it('returns the mocked status and JSON body without calling the target', async () => {
    const state = harness({ http: () => jsonResponse(500, { real: true }) });
    const outcome = await run(
      httpRequestStep as never,
      { ...base, mock: true, mockStatus: 201, mockBody: { id: 7, ok: true } },
      state,
    );
    expect(outcome.result.status).toBe('Succeeded');
    expect(state.http).toHaveLength(0);
    expect(state.resolved).toHaveLength(0);
    expect(outcome.result.output).toMatchObject({
      status: 201,
      statusText: 'Created',
      body: { id: 7, ok: true },
      bodyEncoding: 'json',
      mocked: true,
      durationMs: 0,
    });
  });

  it('defaults a mock to 200 with no body and still applies expectedStatus', async () => {
    const state = harness();
    const empty = await run(httpRequestStep as never, { ...base, mock: true }, state);
    expect(empty.result.output).toMatchObject({ status: 200, body: null, mocked: true });
    const failed = await run(
      httpRequestStep as never,
      { ...base, mock: true, mockStatus: 404, mockBody: { error: 'missing' } },
      state,
    );
    expect(failed.result.status).toBe('Failed');
    expect(failed.result.output).toMatchObject({ status: 404, body: { error: 'missing' } });
    expect(state.http).toHaveLength(0);
    const accepted = await run(
      httpRequestStep as never,
      { ...base, mock: true, mockStatus: 404, expectedStatus: [404] },
      state,
    );
    expect(accepted.result.status).toBe('Succeeded');
  });

  it('still refuses a mocked request the policy would refuse, and ignores mock fields when off', async () => {
    const state = harness();
    expect(
      failureCode(
        await run(
          httpRequestStep as never,
          { target: 'api', path: '/forbidden', mock: true },
          state,
        ),
      ),
    ).toBe('VALIDATION_TARGET_POLICY');
    await run(httpRequestStep as never, { ...base, mockStatus: 418, mockBody: 1 }, state);
    expect(state.http).toHaveLength(1);
  });

  it('uses a bearer token when the reference says so, and a legacy name as an API key', async () => {
    const bearerEnv = {
      id: 'e',
      targets: {
        api: {
          kind: 'http' as const,
          baseUrl: 'https://example.azure-api.net',
          allowedPaths: ['/x'],
          authentication: local('api-key', 'bearerToken'),
        },
      },
    };
    const state = harness({ context: { policy: createTargetPolicy(bearerEnv) } });
    await run(httpRequestStep as never, { target: 'api', path: '/x' }, state);
    expect(state.http[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  it('omits correlation headers when the target disables them', async () => {
    const state = harness();
    await run(httpRequestStep as never, { target: 'noCorrelation', path: '/x' }, state);
    expect(
      Object.keys(state.http[0]?.headers ?? {}).filter((name) => name.startsWith('x-')),
    ).toEqual([]);
  });

  it('cannot override credentials, correlation or framing headers', async () => {
    const state = harness();
    for (const header of [
      'Authorization',
      'Ocp-Apim-Subscription-Key',
      'X-Correlation-Id',
      'Host',
    ]) {
      const outcome = await run(
        httpRequestStep as never,
        { ...base, headers: { [header]: 'spoof' } },
        state,
      );
      expect(failureCode(outcome)).toBe('VALIDATION_TARGET_POLICY');
    }
    expect(state.http).toHaveLength(0);
  });

  it('refuses paths, methods and hosts outside the allowlist before any call', async () => {
    const state = harness();
    for (const config of [
      { target: 'api', path: '/admin' },
      { target: 'api', path: 'https://evil.example/orders/1' },
      { target: 'api', path: '/orders/../admin' },
      { target: 'api', path: '/orders/1', method: 'DELETE' },
      { target: 'missing', path: '/x' },
      { target: 'storage', path: '/x' },
    ]) {
      const outcome = await run(httpRequestStep as never, config, state);
      expect(['VALIDATION_TARGET_POLICY', 'VALIDATION_SCHEMA']).toContain(failureCode(outcome));
    }
    expect(state.http).toHaveLength(0);
    expect(state.resolved).toHaveLength(0);
  });

  it('rejects a body on GET and an oversized body', async () => {
    const state = harness({ context: { limits: { payloadBytes: 1000, transferBytes: 100 } } });
    expect(
      failureCode(await run(httpRequestStep as never, { ...base, body: { a: 1 } }, state)),
    ).toBe('VALIDATION_SCHEMA');
    const big = await run(
      httpRequestStep as never,
      { target: 'api', path: '/orders/1', method: 'POST', body: 'x'.repeat(200) },
      state,
    );
    expect(failureCode(big)).toBe('VALIDATION_TARGET_POLICY');
    expect(state.http).toHaveLength(0);
  });

  it('serialises JSON bodies and keeps a caller content-type', async () => {
    const state = harness();
    await run(
      httpRequestStep as never,
      {
        target: 'api',
        path: '/orders/1',
        method: 'POST',
        body: { a: 1 },
        headers: { 'Content-Type': 'application/vnd.x+json' },
      },
      state,
    );
    expect(new TextDecoder().decode(state.http[0]?.body)).toBe('{"a":1}');
    expect(state.http[0]?.headers['content-type']).toBe('application/vnd.x+json');
  });

  it('honours expectedStatus and reports the response on a mismatch', async () => {
    const state = harness({ http: () => jsonResponse(404, { error: 'nope' }) });
    const outcome = await run(
      httpRequestStep as never,
      { ...base, expectedStatus: [200, 201] },
      state,
    );
    expect(outcome.result.status).toBe('Failed');
    expect(failureCode(outcome)).toBe('TARGET_REQUEST');
    expect(outcome.result.output).toMatchObject({ status: 404 });

    const accepted = harness({ http: () => jsonResponse(404, {}) });
    expect(
      (await run(httpRequestStep as never, { ...base, expectedStatus: [404] }, accepted)).result
        .status,
    ).toBe('Succeeded');
  });

  it.each([
    [401, 'AUTH_CREDENTIAL'],
    [403, 'AUTH_FORBIDDEN'],
    [400, 'TARGET_REQUEST'],
    [302, 'TARGET_REQUEST'],
  ])('maps unexpected status %i to %s', async (status, code) => {
    const state = harness({ http: () => jsonResponse(status, {}) });
    expect(failureCode(await run(httpRequestStep as never, base, state))).toBe(code);
  });

  it('retries 5xx and timeouts only when declared retry-safe', async () => {
    const unsafe = harness({ http: () => jsonResponse(503, {}) });
    const unsafeOutcome = await run(httpRequestStep as never, base, unsafe);
    expect(failureCode(unsafeOutcome)).toBe('TARGET_REQUEST');
    expect(unsafeOutcome.result.error?.message).toContain('will not be retried');
    expect(unsafeOutcome.result.error?.detail).toContain('originalCode=TARGET_SERVICE');
    expect(isRetryableCode(unsafeOutcome.result.error!.code)).toBe(false);

    const safe = harness({ http: () => jsonResponse(503, {}) });
    const safeOutcome = await run(httpRequestStep as never, { ...base, retrySafe: true }, safe);
    expect(failureCode(safeOutcome)).toBe('TARGET_SERVICE');
    expect(isRetryableCode(safeOutcome.result.error!.code)).toBe(true);

    const timeoutUnsafe = harness({ http: () => new PlatformError('TARGET_TIMEOUT', 'timed out') });
    expect(
      isRetryableCode(
        (await run(httpRequestStep as never, base, timeoutUnsafe)).result.error!.code,
      ),
    ).toBe(false);
    const timeoutSafe = harness({ http: () => new PlatformError('TARGET_TIMEOUT', 'timed out') });
    expect(
      failureCode(await run(httpRequestStep as never, { ...base, retrySafe: true }, timeoutSafe)),
    ).toBe('TARGET_TIMEOUT');
  });

  it('does not let an unknown transport error leak its message', async () => {
    const state = harness({
      http: () =>
        Object.assign(new Error(`connect failed for key ${API_KEY}`), { code: 'ECONNRESET' }),
    });
    const outcome = await run(httpRequestStep as never, { ...base, retrySafe: true }, state);
    expect(failureCode(outcome)).toBe('TARGET_SERVICE');
    expect(JSON.stringify(outcome.result)).not.toContain(API_KEY);
  });

  it('truncates a large body inline, stores it as a masked artifact, and masks echoed secrets', async () => {
    const big = JSON.stringify({ echoed: API_KEY, filler: 'x'.repeat(5000) });
    const state = harness({
      http: () => ({
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json', 'set-cookie': 'session=abc123456789' },
        body: new TextEncoder().encode(big),
        truncated: false,
      }),
      context: { limits: { payloadBytes: 1024, transferBytes: 1024 * 1024 } },
    });
    const outcome = await run(httpRequestStep as never, base, state);
    const output = outcome.result.output as Record<string, unknown>;
    expect(output.bodyTruncated).toBe(true);
    expect(String(output.body).length).toBeLessThanOrEqual(512);
    expect(output.bodyArtifact).toBe('artifact-1');
    expect(state.artifacts[0]?.label).toBe('http-response-body');
    expect(typeof state.artifacts[0]?.content).toBe('string');
    expect(JSON.stringify(outcome.result)).not.toContain(API_KEY);
    expect((output.headers as Record<string, string>)['set-cookie']).toBe('***REDACTED***');
  });

  it('encodes binary responses as base64', async () => {
    const state = harness({
      http: () => ({
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array([1, 2, 3]),
        truncated: false,
      }),
    });
    const outcome = await run(httpRequestStep as never, base, state);
    expect(outcome.result.output).toMatchObject({ body: 'AQID', bodyEncoding: 'base64' });
  });

  it('masks the api key in the persisted input headers', async () => {
    const state = harness();
    const outcome = await run(
      httpRequestStep as never,
      { ...base, headers: { 'X-Api-Key': API_KEY, Accept: 'application/json' } },
      state,
    );
    expect(JSON.stringify(outcome.maskedInput)).not.toContain(API_KEY);
  });

  it('fails when the secret reference cannot be resolved, without calling the target', async () => {
    const state = harness({ secrets: {} });
    const outcome = await run(httpRequestStep as never, base, state);
    expect(failureCode(outcome)).toBe('AUTH_SECRET_UNAVAILABLE');
    expect(state.http).toHaveLength(0);
  });

  it('propagates cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const state = harness({ context: { signal: controller.signal } });
    await expect(run(httpRequestStep as never, base, state)).rejects.toMatchObject({
      code: 'EXECUTION_CANCELLED',
    });
  });
});

describe('blob.upload', () => {
  const base = {
    target: 'storage',
    container: 'inbound-orders',
    blobName: 'runs/run-1/order.json',
    content: { id: 1 },
  };

  it('uploads JSON with correlation metadata and records the ETag', async () => {
    const state = harness();
    const outcome = await run(blobUploadStep as never, base, state);
    expect(outcome.result.status).toBe('Succeeded');
    const [upload] = state.blobUploads;
    expect(new TextDecoder().decode(upload?.content)).toBe('{"id":1}');
    expect(upload?.contentType).toBe('application/json');
    expect(upload?.overwrite).toBe(false);
    expect(upload?.metadata).toMatchObject({
      platform_run_id: 'run-1',
      platform_step_run_id: 'step-run-1',
      platform_node_id: 'node-a',
      platform_attempt: '2',
    });
    expect(outcome.result.output).toMatchObject({
      etag: '"0x1"',
      sizeBytes: 8,
      overwrite: false,
      reusedFromEarlierAttempt: false,
    });
    expect(state.opened).toEqual([{ kind: 'blob' }]);
    expect(state.closed).toEqual(['blob']);
    expect(state.resolved).toHaveLength(0);
  });

  it('decodes base64 content', async () => {
    const state = harness();
    await run(
      blobUploadStep as never,
      { ...base, content: 'AQID', contentEncoding: 'base64' },
      state,
    );
    expect([...(state.blobUploads[0]?.content ?? [])]).toEqual([1, 2, 3]);
    expect(state.blobUploads[0]?.contentType).toBe('application/octet-stream');
    expect(
      failureCode(
        await run(
          blobUploadStep as never,
          { ...base, content: '!!', contentEncoding: 'base64' },
          state,
        ),
      ),
    ).toBe('VALIDATION_SCHEMA');
  });

  it('refuses containers, prefixes, operations and names outside the policy', async () => {
    const state = harness();
    for (const patch of [
      { container: 'other' },
      { blobName: 'elsewhere/a.json' },
      { blobName: 'runs/../x' },
      { target: 'bus' },
    ]) {
      expect(failureCode(await run(blobUploadStep as never, { ...base, ...patch }, state))).toBe(
        'VALIDATION_TARGET_POLICY',
      );
    }
    expect(state.blobUploads).toHaveLength(0);
  });

  it('uploads each file as a blob named after it', async () => {
    const state = harness();
    const files = [
      { name: 'runs/a.bin', content: 'AQID' },
      { name: 'runs/b.txt', content: 'aGk=', contentType: 'text/plain' },
    ];
    const outcome = await run(
      blobUploadStep as never,
      { target: 'storage', container: 'inbound-orders', files },
      state,
    );
    expect(outcome.result.status).toBe('Succeeded');
    expect(state.blobUploads.map((upload) => upload.blobName)).toEqual([
      'runs/a.bin',
      'runs/b.txt',
    ]);
    expect([...(state.blobUploads[0]?.content ?? [])]).toEqual([1, 2, 3]);
    expect(state.blobUploads[1]?.contentType).toBe('text/plain');
    expect(outcome.result.output).toMatchObject({ count: 2, totalBytes: 5 });
    expect(state.opened).toEqual([{ kind: 'blob' }]);
  });

  it('writes nothing when one file is outside the policy or the source is ambiguous', async () => {
    const state = harness();
    const files = [
      { name: 'runs/a.bin', content: 'AQID' },
      { name: 'elsewhere/b.bin', content: 'AQID' },
    ];
    expect(
      failureCode(
        await run(
          blobUploadStep as never,
          { target: 'storage', container: 'inbound-orders', files },
          state,
        ),
      ),
    ).toBe('VALIDATION_TARGET_POLICY');
    expect(
      failureCode(await run(blobUploadStep as never, { ...base, files: files.slice(0, 1) }, state)),
    ).toBe('VALIDATION_SCHEMA');
    expect(state.blobUploads).toHaveLength(0);
  });

  it('enforces the upload size cap', async () => {
    const state = harness({ context: { limits: { payloadBytes: 1000, transferBytes: 10 } } });
    expect(
      failureCode(await run(blobUploadStep as never, { ...base, content: 'x'.repeat(50) }, state)),
    ).toBe('VALIDATION_TARGET_POLICY');
    expect(state.blobUploads).toHaveLength(0);
  });

  it('fails on an existing blob unless overwrite is set', async () => {
    const blobs = new Map();
    const first = harness({
      blobs,
      context: {
        correlation: { runId: 'other-run', stepRunId: 's0', nodeId: 'node-a', attempt: 1 },
      },
    });
    await run(blobUploadStep as never, base, first);

    const state = harness({ blobs });
    const outcome = await run(blobUploadStep as never, base, state);
    expect(failureCode(outcome)).toBe('TARGET_REQUEST');
    expect(outcome.result.error?.message).toContain('already exists');

    const overwrite = await run(blobUploadStep as never, { ...base, overwrite: true }, state);
    expect(overwrite.result.status).toBe('Succeeded');
    expect(state.blobUploads.at(-1)?.overwrite).toBe(true);
  });

  it('treats a blob written by an earlier attempt of the same Step as success', async () => {
    const blobs = new Map();
    await run(
      blobUploadStep as never,
      base,
      harness({
        blobs,
        context: {
          correlation: { runId: 'run-1', stepRunId: 'old', nodeId: 'node-a', attempt: 1 },
        },
      }),
    );
    const retry = harness({ blobs });
    const outcome = await run(blobUploadStep as never, base, retry);
    expect(outcome.result.status).toBe('Succeeded');
    expect(outcome.result.output).toMatchObject({ reusedFromEarlierAttempt: true });

    const different = await run(
      blobUploadStep as never,
      { ...base, content: { id: 2 } },
      harness({ blobs }),
    );
    expect(failureCode(different)).toBe('TARGET_REQUEST');
  });

  it('rejects reserved or malformed metadata', async () => {
    const state = harness();
    expect(
      failureCode(
        await run(blobUploadStep as never, { ...base, metadata: { platform_run_id: 'x' } }, state),
      ),
    ).toBe('VALIDATION_SCHEMA');
    expect(
      failureCode(
        await run(blobUploadStep as never, { ...base, metadata: { 'bad key': 'x' } }, state),
      ),
    ).toBe('VALIDATION_SCHEMA');
    expect(
      (await run(blobUploadStep as never, { ...base, metadata: { Tag: 'ok' } }, state)).result
        .status,
    ).toBe('Succeeded');
    expect(state.blobUploads.at(-1)?.metadata.tag).toBe('ok');
  });

  it('uses and masks a referenced connection string, and checks its account', async () => {
    const state = harness();
    const config = { ...base, target: 'storageConn' };
    const outcome = await run(blobUploadStep as never, config, state);
    expect(outcome.result.status).toBe('Succeeded');
    expect(state.opened).toEqual([{ kind: 'blob', connectionString: BLOB_CONNECTION }]);
    expect(JSON.stringify(outcome)).not.toContain(BLOB_KEY);
    expect(outcome.result.logs.map((entry) => entry.message).join('\n')).toContain('blob-conn');

    const wrong = harness({
      secrets: { 'blob-conn': BLOB_CONNECTION.replace('AccountName=example', 'AccountName=other') },
    });
    expect(failureCode(await run(blobUploadStep as never, config, wrong))).toBe(
      'VALIDATION_TARGET_POLICY',
    );
    expect(wrong.opened).toHaveLength(0);
  });

  it('maps SDK failures without leaking their text and keeps timeouts retryable', async () => {
    const leaky = Object.assign(
      new Error(`Request to https://x/?sig=topsecretsig failed; ${BLOB_KEY}`),
      {
        statusCode: 503,
        code: 'ServerBusy',
      },
    );
    const state = harness({ uploadError: leaky });
    const outcome = await run(blobUploadStep as never, base, state);
    expect(failureCode(outcome)).toBe('TARGET_SERVICE');
    expect(JSON.stringify(outcome)).not.toContain('topsecretsig');
    expect(JSON.stringify(outcome)).not.toContain(BLOB_KEY);
    expect(state.closed).toEqual(['blob']);
  });
});

describe('blob.download', () => {
  const entry = (text: string, extra: Partial<BlobProperties> = {}) => ({
    content: new TextEncoder().encode(text),
    properties: {
      etag: '"0x9"',
      contentType: 'application/json',
      contentLength: text.length,
      metadata: {},
      ...extra,
    },
  });
  const base = {
    target: 'storage',
    container: 'inbound-orders',
    blobName: 'runs/run-1/order.json',
  };

  it('returns parsed JSON, the ETag, and stores an artifact', async () => {
    const blobs = new Map([['inbound-orders/runs/run-1/order.json', entry('{"id":7}')]]);
    const state = harness({ blobs });
    const outcome = await run(blobDownloadStep as never, { ...base, as: 'json' }, state);
    expect(outcome.result.output).toMatchObject({
      etag: '"0x9"',
      content: { id: 7 },
      contentEncoding: 'json',
      sizeBytes: 8,
      artifactId: 'artifact-1',
    });
    expect(state.artifacts[0]).toMatchObject({ label: 'blob-content', content: '{"id":7}' });
    expect(outcome.result.artifacts).toHaveLength(1);
  });

  it('checks the expected ETag, JSON validity and the size limit', async () => {
    const blobs = new Map([['inbound-orders/runs/run-1/order.json', entry('not json')]]);
    const state = harness({ blobs });
    expect(failureCode(await run(blobDownloadStep as never, { ...base, as: 'json' }, state))).toBe(
      'TARGET_REQUEST',
    );
    expect(
      failureCode(
        await run(blobDownloadStep as never, { ...base, expectedEtag: '"other"' }, state),
      ),
    ).toBe('TARGET_REQUEST');
    expect(failureCode(await run(blobDownloadStep as never, { ...base, maxBytes: 3 }, state))).toBe(
      'TARGET_REQUEST',
    );
  });

  it('keeps large content out of the inline output', async () => {
    const text = 'y'.repeat(5000);
    const blobs = new Map([
      ['inbound-orders/runs/run-1/order.json', entry(text, { contentType: 'text/plain' })],
    ]);
    const state = harness({
      blobs,
      context: { limits: { payloadBytes: 1024, transferBytes: 1024 * 1024 } },
    });
    const outcome = await run(blobDownloadStep as never, base, state);
    const output = outcome.result.output as Record<string, unknown>;
    expect(output.contentTruncated).toBe(true);
    expect(String(output.content).length).toBe(512);
    expect(state.artifacts[0]?.content).toBe(text);
  });

  it('masks a secret found in the content', async () => {
    const blobs = new Map([
      [
        'inbound-orders/runs/run-1/order.json',
        entry(`token ${API_KEY}`, { contentType: 'text/plain' }),
      ],
    ]);
    const outcome = await run(blobDownloadStep as never, base, harness({ blobs }));
    expect(JSON.stringify(outcome.result)).not.toContain(API_KEY);
  });

  it('is limited to download-capable targets and approved prefixes', async () => {
    const state = harness();
    expect(
      failureCode(
        await run(blobDownloadStep as never, { ...base, blobName: 'private/x.json' }, state),
      ),
    ).toBe('VALIDATION_TARGET_POLICY');
    expect(
      failureCode(await run(blobDownloadStep as never, { ...base, container: 'other' }, state)),
    ).toBe('VALIDATION_TARGET_POLICY');
  });
});

describe('serviceBus.send', () => {
  const base = { target: 'bus', entity: 'order-events', body: { orderId: 1 } };

  it('sends with deterministic IDs and platform properties via the referenced connection string', async () => {
    const state = harness();
    const outcome = await run(serviceBusSendStep as never, base, state);
    expect(outcome.result.status).toBe('Succeeded');
    expect(state.opened).toEqual([{ kind: 'serviceBus', connectionString: SB_CONNECTION }]);
    const sent = state.messages[0];
    expect(sent?.entity).toBe('order-events');
    expect(sent?.message.messageId).toBe('run-1-node-a');
    expect(sent?.message.correlationId).toBe('run-1');
    expect(sent?.message.contentType).toBe('application/json');
    expect(sent?.message.applicationProperties).toMatchObject({
      platform_run_id: 'run-1',
      platform_step_run_id: 'step-run-1',
      platform_attempt: 2,
    });
    expect(state.closed).toEqual(['serviceBus']);
    expect(JSON.stringify(outcome)).not.toContain(SB_KEY);
    expect(JSON.stringify(outcome)).not.toContain(SB_CONNECTION);
  });

  it('keeps the message ID identical across attempts', async () => {
    const first = harness();
    const second = harness({
      context: {
        correlation: { runId: 'run-1', stepRunId: 'step-run-9', nodeId: 'node-a', attempt: 3 },
      },
    });
    await run(serviceBusSendStep as never, base, first);
    await run(serviceBusSendStep as never, base, second);
    expect(second.messages[0]?.message.messageId).toBe(first.messages[0]?.message.messageId);
  });

  it('uses Entra credentials when the target has no connection string', async () => {
    const state = harness();
    const outcome = await run(serviceBusSendStep as never, { ...base, target: 'busEntra' }, state);
    expect(outcome.result.status).toBe('Succeeded');
    expect(state.opened).toEqual([{ kind: 'serviceBus' }]);
    expect(state.resolved).toHaveLength(0);
    expect(outcome.result.logs.map((entry) => entry.message).join('\n')).toContain(
      'DefaultAzureCredential',
    );
  });

  it('refuses entities outside the allowlist and oversized messages', async () => {
    const state = harness();
    expect(
      failureCode(
        await run(serviceBusSendStep as never, { ...base, entity: 'dead-letter' }, state),
      ),
    ).toBe('VALIDATION_TARGET_POLICY');
    const big = harness({ context: { limits: { payloadBytes: 1000, transferBytes: 10 } } });
    expect(
      failureCode(await run(serviceBusSendStep as never, { ...base, body: 'x'.repeat(20) }, big)),
    ).toBe('VALIDATION_TARGET_POLICY');
    expect(state.messages).toHaveLength(0);
    expect(big.messages).toHaveLength(0);
    expect(big.opened).toHaveLength(0);
  });

  it('refuses a connection string that points at another namespace', async () => {
    const state = harness({ secrets: { 'bus-conn': SB_CONNECTION.replace('example.', 'other.') } });
    const outcome = await run(serviceBusSendStep as never, base, state);
    expect(failureCode(outcome)).toBe('VALIDATION_TARGET_POLICY');
    expect(state.opened).toHaveLength(0);
    expect(JSON.stringify(outcome)).not.toContain(SB_KEY);
  });

  it('validates message IDs and property names', async () => {
    const state = harness();
    expect(
      failureCode(
        await run(serviceBusSendStep as never, { ...base, messageId: 'has space' }, state),
      ),
    ).toBe('VALIDATION_SCHEMA');
    expect(
      failureCode(
        await run(
          serviceBusSendStep as never,
          { ...base, applicationProperties: { platform_run_id: 'x' } },
          state,
        ),
      ),
    ).toBe('VALIDATION_SCHEMA');
  });

  it('retries transient failures only with duplicate detection or an explicit opt-in', async () => {
    const transient = () =>
      Object.assign(new Error(`broker said ${SB_KEY}`), { code: 'ServiceUnavailableError' });
    const plain = harness({ sendError: transient() });
    const plainOutcome = await run(serviceBusSendStep as never, base, plain);
    expect(failureCode(plainOutcome)).toBe('TARGET_REQUEST');
    expect(isRetryableCode(plainOutcome.result.error!.code)).toBe(false);
    expect(
      plainOutcome.result.logs.some(
        (entry) => entry.level === 'warn' && entry.message.includes('Duplicate detection'),
      ),
    ).toBe(true);
    expect(JSON.stringify(plainOutcome)).not.toContain(SB_KEY);

    const detected = await run(
      serviceBusSendStep as never,
      { ...base, duplicateDetection: true },
      harness({ sendError: transient() }),
    );
    expect(failureCode(detected)).toBe('TARGET_SERVICE');
    const optedIn = await run(
      serviceBusSendStep as never,
      { ...base, retrySafe: true },
      harness({ sendError: transient() }),
    );
    expect(failureCode(optedIn)).toBe('TARGET_SERVICE');
    expect(
      optedIn.result.logs.some(
        (entry) => entry.level === 'warn' && entry.message.includes('twice'),
      ),
    ).toBe(true);
  });

  it('keeps non-transient failures non-retryable regardless of policy', async () => {
    const denied = Object.assign(new Error('nope'), { code: 'UnauthorizedError' });
    const outcome = await run(
      serviceBusSendStep as never,
      { ...base, duplicateDetection: true },
      harness({ sendError: denied }),
    );
    expect(failureCode(outcome)).toBe('AUTH_FORBIDDEN');
  });

  it('fails clearly when the connection string secret is missing', async () => {
    const state = harness({ secrets: {} });
    const outcome = await run(serviceBusSendStep as never, base, state);
    expect(failureCode(outcome)).toBe('AUTH_SECRET_UNAVAILABLE');
    expect(state.opened).toHaveLength(0);
  });
});

describe('serviceBus.send inspector option', () => {
  const base = { target: 'bus', entity: 'order-events', body: { orderId: 1 } };
  const inspectEnv = {
    id: 'orders-test',
    targets: {
      bus: {
        ...environment.targets.bus,
        allowedOperations: ['send', 'inspect'],
      },
    },
  } as unknown as typeof environment;

  const recorder = (failWith?: unknown) => {
    const calls = { watches: [] as unknown[], sent: [] as unknown[] };
    return {
      calls,
      inspector: {
        registerWatch: (input: unknown) => {
          if (failWith) return Promise.reject(failWith);
          calls.watches.push(input);
          return Promise.resolve({ created: true });
        },
        recordSent: (message: unknown) => {
          calls.sent.push(message);
          return Promise.resolve();
        },
      },
    };
  };

  it('does nothing unless asked', async () => {
    const r = recorder();
    const state = harness({ context: { inspector: r.inspector } });
    const outcome = await run(serviceBusSendStep as never, base, state);
    expect(r.calls).toEqual({ watches: [], sent: [] });
    expect(outcome.result.output).toMatchObject({ inspector: 'not-requested' });
  });

  it('records a copy of the sent message and registers the queue when the target allows inspect', async () => {
    const r = recorder();
    const state = harness({
      context: {
        inspector: r.inspector,
        policy: createTargetPolicy(inspectEnv),
        environmentId: 'orders-test',
      },
    });
    const outcome = await run(serviceBusSendStep as never, { ...base, inspect: true }, state);
    expect(outcome.result.status).toBe('Succeeded');
    expect(outcome.result.output).toMatchObject({ inspector: 'registered' });
    expect(r.calls.watches).toEqual([
      {
        environmentId: 'orders-test',
        target: 'bus',
        entity: 'order-events',
        createdBy: 'run:run-1',
      },
    ]);
    expect(r.calls.sent).toHaveLength(1);
    expect(r.calls.sent[0]).toMatchObject({
      environmentId: 'orders-test',
      entity: 'order-events',
      messageId: 'run-1-node-a',
      runId: 'run-1',
      stepRunId: 'step-run-1',
      nodeId: 'node-a',
    });
    expect(new TextDecoder().decode((r.calls.sent[0] as { body: Uint8Array }).body)).toBe(
      '{"orderId":1}',
    );
  });

  it('registers a topic subscription when one is named', async () => {
    const r = recorder();
    const state = harness({
      context: {
        inspector: r.inspector,
        policy: createTargetPolicy(inspectEnv),
        environmentId: 'orders-test',
      },
    });
    await run(
      serviceBusSendStep as never,
      { ...base, inspect: true, inspectSubscription: 'inspector' },
      state,
    );
    expect(r.calls.watches[0]).toMatchObject({ subscription: 'inspector' });
    expect(r.calls.sent[0]).toMatchObject({ subscription: 'inspector' });
  });

  it('still records the copy, with a warning, when the target does not allow inspect', async () => {
    const r = recorder();
    const state = harness({ context: { inspector: r.inspector } });
    const outcome = await run(serviceBusSendStep as never, { ...base, inspect: true }, state);
    expect(outcome.result.status).toBe('Succeeded');
    expect(outcome.result.output).toMatchObject({ inspector: 'not-allowed' });
    expect(r.calls.watches).toEqual([]);
    expect(r.calls.sent).toHaveLength(1);
    expect(
      outcome.result.logs.some(
        (entry) => entry.level === 'warn' && entry.message.includes('"inspect"'),
      ),
    ).toBe(true);
  });

  it('never fails the Step when the inspector breaks', async () => {
    const r = recorder(new Error('database is locked'));
    const state = harness({
      context: { inspector: r.inspector, policy: createTargetPolicy(inspectEnv) },
    });
    const outcome = await run(serviceBusSendStep as never, { ...base, inspect: true }, state);
    expect(outcome.result.status).toBe('Succeeded');
    expect(outcome.result.output).toMatchObject({ inspector: 'failed' });
    expect(JSON.stringify(outcome.result)).not.toContain('database is locked');
  });

  it('does not record a message whose send failed', async () => {
    const r = recorder();
    const state = harness({
      sendError: Object.assign(new Error('x'), { code: 'ServiceUnavailableError' }),
      context: { inspector: r.inspector, policy: createTargetPolicy(inspectEnv) },
    });
    const outcome = await run(serviceBusSendStep as never, { ...base, inspect: true }, state);
    expect(outcome.result.status).toBe('Failed');
    expect(r.calls).toEqual({ watches: [], sent: [] });
  });

  it('validates the subscription option', async () => {
    const state = harness();
    expect(
      failureCode(
        await run(
          serviceBusSendStep as never,
          { ...base, inspect: true, inspectSubscription: 'bad name!' },
          state,
        ),
      ),
    ).toBe('VALIDATION_SCHEMA');
    expect(
      failureCode(
        await run(serviceBusSendStep as never, { ...base, inspectSubscription: 'ok' }, state),
      ),
    ).toBe('VALIDATION_SCHEMA');
  });
});

describe('waitForCondition', () => {
  const poll = {
    probe: 'http',
    target: 'api',
    path: '/jobs/1',
    intervalSeconds: 1,
    maxAttempts: 5,
    maxDurationSeconds: 60,
  };

  const timeline = () => {
    let now = 0;
    const sleeps: number[] = [];
    return {
      sleeps,
      context: {
        clock: { now: () => new Date(now) },
        sleep: (ms: number) => {
          sleeps.push(ms);
          now += ms;
          return Promise.resolve();
        },
      },
    };
  };

  it('polls until the status and body condition holds', async () => {
    const t = timeline();
    const state = harness({
      http: (_request, call) => jsonResponse(200, { state: call < 2 ? 'Pending' : 'Done' }),
      context: t.context,
    });
    const outcome = await run(
      waitForConditionStep as never,
      { ...poll, untilBody: { path: 'state', operator: 'equals', expected: 'Done' } },
      state,
    );
    expect(outcome.result.status).toBe('Succeeded');
    expect(outcome.result.output).toMatchObject({ satisfied: true, polls: 3 });
    expect(state.http).toHaveLength(3);
    expect(t.sleeps).toEqual([1000, 1000]);
  });

  it('applies backoff up to the interval cap', async () => {
    const t = timeline();
    const state = harness({ http: () => jsonResponse(202, {}), context: t.context });
    await run(
      waitForConditionStep as never,
      {
        ...poll,
        maxAttempts: 6,
        backoffMultiplier: 2,
        maxIntervalSeconds: 4,
        maxDurationSeconds: 600,
      },
      state,
    );
    expect(t.sleeps).toEqual([1000, 2000, 4000, 4000, 4000]);
  });

  it('stops at maxAttempts with a non-retryable failure', async () => {
    const t = timeline();
    const state = harness({ http: () => jsonResponse(202, {}), context: t.context });
    const outcome = await run(waitForConditionStep as never, poll, state);
    expect(outcome.result.status).toBe('Failed');
    expect(failureCode(outcome)).toBe('EXECUTION_ASSERTION_FAILED');
    expect(isRetryableCode(outcome.result.error!.code)).toBe(false);
    expect(state.http).toHaveLength(5);
  });

  it('stops when the next wait would exceed maxDurationSeconds', async () => {
    const t = timeline();
    const state = harness({ http: () => jsonResponse(202, {}), context: t.context });
    await run(
      waitForConditionStep as never,
      { ...poll, maxAttempts: 100, maxDurationSeconds: 3 },
      state,
    );
    expect(state.http.length).toBeLessThanOrEqual(4);
    expect(t.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(3000);
  });

  it('tolerates transient errors but not policy or credential errors', async () => {
    const t = timeline();
    const flaky = harness({
      http: (_request, call) =>
        call === 0 ? new PlatformError('TARGET_TIMEOUT', 'slow') : jsonResponse(200, {}),
      context: t.context,
    });
    expect((await run(waitForConditionStep as never, poll, flaky)).result.status).toBe('Succeeded');

    const denied = harness({
      http: () => new PlatformError('AUTH_CREDENTIAL', 'denied'),
      context: timeline().context,
    });
    expect(failureCode(await run(waitForConditionStep as never, poll, denied))).toBe(
      'AUTH_CREDENTIAL',
    );
    expect(denied.http).toHaveLength(1);

    const outside = harness({ context: timeline().context });
    expect(
      failureCode(await run(waitForConditionStep as never, { ...poll, path: '/admin' }, outside)),
    ).toBe('VALIDATION_TARGET_POLICY');
    expect(outside.http).toHaveLength(0);
  });

  it('is cancellable while waiting', async () => {
    const controller = new AbortController();
    const state = harness({
      http: () => jsonResponse(202, {}),
      context: {
        signal: controller.signal,
        sleep: () => {
          controller.abort();
          return Promise.reject(new PlatformError('EXECUTION_CANCELLED', 'cancelled'));
        },
      },
    });
    await expect(run(waitForConditionStep as never, poll, state)).rejects.toMatchObject({
      code: 'EXECUTION_CANCELLED',
    });
    expect(state.http).toHaveLength(1);
  });

  it('polls for blob existence', async () => {
    const t = timeline();
    const blobs = new Map();
    let calls = 0;
    const state = harness({ blobs, context: t.context });
    const original = state.context.clients.openBlob;
    state.context.clients.openBlob = (connection) => {
      const port = original(connection);
      return {
        ...port,
        getProperties: (input) => {
          calls += 1;
          if (calls === 3)
            blobs.set('inbound-orders/runs/ready.json', {
              content: new Uint8Array(),
              properties: { contentLength: 4, metadata: {} },
            });
          return port.getProperties(input);
        },
      };
    };
    const outcome = await run(
      waitForConditionStep as never,
      {
        probe: 'blobExists',
        target: 'storage',
        container: 'inbound-orders',
        blobName: 'runs/ready.json',
        intervalSeconds: 1,
        maxAttempts: 5,
      },
      state,
    );
    expect(outcome.result.status).toBe('Succeeded');
    expect(outcome.result.output).toMatchObject({ polls: 3, last: { exists: true, sizeBytes: 4 } });
    expect(state.closed.filter((kind) => kind === 'blob')).toHaveLength(3);
  });

  it('rejects inconsistent configuration and out-of-range bounds', async () => {
    const state = harness();
    expect(
      failureCode(
        await run(waitForConditionStep as never, { probe: 'http', target: 'api' }, state),
      ),
    ).toBe('VALIDATION_SCHEMA');
    expect(
      failureCode(
        await run(waitForConditionStep as never, { ...poll, maxAttempts: 10_000 }, state),
      ),
    ).toBe('VALIDATION_SCHEMA');
    expect(
      failureCode(await run(waitForConditionStep as never, { ...poll, intervalSeconds: 0 }, state)),
    ).toBe('VALIDATION_SCHEMA');
    expect(
      failureCode(
        await run(waitForConditionStep as never, { ...poll, maxDurationSeconds: 99_999 }, state),
      ),
    ).toBe('VALIDATION_SCHEMA');
    expect(
      failureCode(await run(waitForConditionStep as never, { ...poll, method: 'POST' }, state)),
    ).toBe('VALIDATION_SCHEMA');
  });
});

describe('checkTargetStepPolicy', () => {
  const policy = createTargetPolicy(environment);

  it('accepts policy-conformant literal parameters', () => {
    expect(
      checkTargetStepPolicy('http.request', { target: 'api', path: '/orders/1' }, policy),
    ).toEqual([]);
    expect(checkTargetStepPolicy('delay', { durationSeconds: 1 }, policy)).toEqual([]);
  });

  it.each([
    ['http.request', { target: 'api', path: '/nope' }],
    ['blob.upload', { target: 'storage', container: 'x', blobName: 'runs/a', content: '' }],
    ['blob.download', { target: 'storage', container: 'inbound-orders', blobName: 'private/a' }],
    ['serviceBus.send', { target: 'bus', entity: 'nope', body: '' }],
    ['waitForCondition', { probe: 'http', target: 'api', path: '/nope' }],
  ])('reports %s violations as target-policy issues', (type, parameters) => {
    const issues = checkTargetStepPolicy(type, parameters as never, policy);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.keyword).toBe('target-policy');
  });
});

void realClock;
