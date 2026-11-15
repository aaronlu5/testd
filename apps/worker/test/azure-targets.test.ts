import { afterEach, describe, expect, it } from 'vitest';
import type { EnvironmentConfig } from '@test-platform/contracts';
import {
  PlatformError,
  type BlobPort,
  type BlobProperties,
  type HttpTransportRequest,
  type OutgoingMessage,
  type TargetClients,
} from '@test-platform/core';
import {
  cleanupAll,
  createHarness,
  environment,
  eventsOf,
  makeRun,
  node,
  stepRuns,
  submit,
  type Harness,
} from './helpers.js';

afterEach(cleanupAll);

// Test-only values, shaped like real credentials so masking is exercised.
const SB_KEY = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==';
const SB_CONNECTION = `Endpoint=sb://example.servicebus.windows.net/;SharedAccessKeyName=send;SharedAccessKey=${SB_KEY}`;
const BLOB_KEY = 'YmxvYmtleWJsb2JrZXlibG9ia2V5MTIzNA==';
const BLOB_CONNECTION = `DefaultEndpointsProtocol=https;AccountName=example;AccountKey=${BLOB_KEY};EndpointSuffix=core.windows.net`;
const API_KEY = 'apikey-0123456789abcdef';
const SECRETS = [SB_CONNECTION, SB_KEY, BLOB_CONNECTION, BLOB_KEY, API_KEY];

const env = {
  TEST_PLATFORM_SECRET_ORDERS_SERVICE_BUS_CONNECTION: SB_CONNECTION,
  TEST_PLATFORM_SECRET_ORDERS_BLOB_CONNECTION: BLOB_CONNECTION,
  TEST_PLATFORM_SECRET_ORDERS_API_KEY: API_KEY,
};

const local = (name: string, usage: 'connectionString' | 'apiKey') =>
  ({ type: 'secretReference', provider: 'localPlainText', name, usage }) as const;

const targetEnvironment = (overrides: Partial<EnvironmentConfig> = {}): EnvironmentConfig =>
  environment({
    limits: { maxRetryAttempts: 3 },
    targets: {
      api: {
        kind: 'http',
        baseUrl: 'https://example.azure-api.net',
        allowedPaths: ['/orders/*'],
        authentication: local('orders-api-key', 'apiKey'),
      },
      vaultApi: {
        kind: 'http',
        baseUrl: 'https://example.azure-api.net',
        allowedPaths: ['/orders/*'],
        authentication: { type: 'secretReference', provider: 'keyVault', name: 'orders-api-key' },
      },
      storage: {
        kind: 'azureBlob',
        accountUrl: 'https://example.blob.core.windows.net',
        allowedContainers: ['inbound-orders'],
        credential: local('orders-blob-connection', 'connectionString'),
      },
      events: {
        kind: 'azureServiceBus',
        fullyQualifiedNamespace: 'example.servicebus.windows.net',
        allowedEntities: ['order-events'],
        credential: local('orders-service-bus-connection', 'connectionString'),
      },
    },
    ...overrides,
  });

type Fakes = {
  clients: TargetClients;
  requests: HttpTransportRequest[];
  messages: OutgoingMessage[];
  sendFailures: { count: number; error: unknown };
  opened: (string | undefined)[];
};

const fakes = (): Fakes => {
  const state: Fakes = {
    requests: [],
    messages: [],
    opened: [],
    sendFailures: { count: 0, error: undefined },
    clients: undefined as never,
  };
  const blobs = new Map<string, { content: Uint8Array; properties: BlobProperties }>();
  const blob = (): BlobPort => ({
    upload: (input) => {
      const properties: BlobProperties = {
        etag: '"0x1"',
        contentLength: input.content.byteLength,
        metadata: input.metadata,
      };
      blobs.set(`${input.container}/${input.blobName}`, { content: input.content, properties });
      return Promise.resolve({ created: true, properties });
    },
    getProperties: (input) =>
      Promise.resolve(blobs.get(`${input.container}/${input.blobName}`)?.properties),
    download: (input) => {
      const found = blobs.get(`${input.container}/${input.blobName}`);
      return found
        ? Promise.resolve(found)
        : Promise.reject(new PlatformError('TARGET_REQUEST', 'x'));
    },
    close: () => Promise.resolve(),
  });
  state.clients = {
    http: {
      send: (request) => {
        state.requests.push(request);
        return Promise.resolve({
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
          // A misbehaving target that echoes the credential it was given.
          body: new TextEncoder().encode(JSON.stringify({ echoedKey: API_KEY, id: 7 })),
          truncated: false,
        });
      },
    },
    openBlob: (connection) => {
      state.opened.push(connection.connectionString);
      return blob();
    },
    openSql: () => {
      throw new Error('sql is not available in tests');
    },
    openServiceBus: (connection) => {
      state.opened.push(connection.connectionString);
      return {
        send: (input) => {
          state.messages.push(input.message);
          if (state.sendFailures.count > 0) {
            state.sendFailures.count -= 1;
            return Promise.reject(state.sendFailures.error);
          }
          return Promise.resolve();
        },
        peek: () => Promise.resolve([]),
        close: () => Promise.resolve(),
      };
    },
  };
  return state;
};

/** Everything the platform persisted or logged for a Run, as one searchable string. */
const everything = async (h: Harness, runId: string): Promise<string> => {
  const steps = await stepRuns(h.container, runId);
  const events = await eventsOf(h.container, runId);
  const artifacts: string[] = [];
  for (const reference of steps.flatMap((step) => step.artifacts)) {
    const stored = await h.container.infra.artifacts.read(reference.id);
    if (stored) artifacts.push(Buffer.from(stored.content).toString('utf8'));
  }
  // The Run snapshot is the Test as authored (the planted echo below is a literal in the fixture
  // Test, which the API would refuse to save); everything the worker produced is checked.
  const run = await h.container.infra.runs.getRun(runId);
  return JSON.stringify({ status: run?.status, steps, events, artifacts, logs: h.logs });
};

const execute = async (h: Harness, runId: string): Promise<void> => {
  await h.container.loop.runOnce();
  void runId;
};

describe('Azure target Steps in the worker', () => {
  it('runs HTTP, Blob and Service Bus Steps and never persists a resolved secret', async () => {
    const f = fakes();
    const h = await createHarness({ env, targetClients: f.clients });
    const run = makeRun(
      [
        node('call', 'http.request', { target: 'api', path: '/orders/7' }),
        node('put', 'blob.upload', {
          target: 'storage',
          container: 'inbound-orders',
          blobName: 'runs/order-7.json',
          content: { id: 7, note: `echo ${API_KEY}` },
          overwrite: true,
        }),
        node('get', 'blob.download', {
          target: 'storage',
          container: 'inbound-orders',
          blobName: 'runs/order-7.json',
          as: 'text',
        }),
        node('send', 'serviceBus.send', {
          target: 'events',
          entity: 'order-events',
          body: { id: 7 },
          duplicateDetection: true,
        }),
      ],
      { environment: targetEnvironment() },
    );
    await submit(h.container, run);
    await execute(h, run.id);

    expect((await h.container.infra.runs.getRun(run.id))?.status).toBe('Succeeded');
    // The secrets did reach the clients, in memory...
    expect(f.requests[0]?.headers['ocp-apim-subscription-key']).toBe(API_KEY);
    expect(f.opened).toEqual([BLOB_CONNECTION, BLOB_CONNECTION, SB_CONNECTION]);
    expect(f.messages[0]?.messageId).toBe(`${run.id}-send`);

    // ...and nowhere that is stored, streamed or logged.
    const dump = await everything(h, run.id);
    for (const secret of SECRETS) expect(dump).not.toContain(secret);
    expect(dump).toContain('orders-service-bus-connection');
    expect(dump).toContain('***REDACTED***');
    expect(JSON.stringify(h.container.infra.secrets.sensitiveValues())).toContain(SB_KEY);
  });

  it('never answers a keyVault reference from a local plain-text secret of the same name', async () => {
    const f = fakes();
    const h = await createHarness({ env, targetClients: f.clients });
    const run = makeRun([node('call', 'http.request', { target: 'vaultApi', path: '/orders/7' })], {
      environment: targetEnvironment(),
    });
    await submit(h.container, run);
    await execute(h, run.id);

    const record = await h.container.infra.runs.getRun(run.id);
    expect(record?.status).toBe('Failed');
    expect(f.requests).toHaveLength(0);
    const [step] = await stepRuns(h.container, run.id);
    expect(step?.error?.code).toBe('AUTH_SECRET_UNAVAILABLE');
    expect(await everything(h, run.id)).not.toContain(API_KEY);
  });

  it('retries a Service Bus send only when duplicate detection or an opt-in allows it', async () => {
    const transient = Object.assign(new Error(`broker said ${SB_CONNECTION}`), {
      code: 'ServiceUnavailableError',
    });
    const retry = { maxAttempts: 3, initialDelayMs: 1, backoffMultiplier: 1, maxDelayMs: 1 };

    const safe = fakes();
    safe.sendFailures = { count: 1, error: transient };
    const h1 = await createHarness({ env, targetClients: safe.clients });
    const run1 = makeRun(
      [
        node(
          'send',
          'serviceBus.send',
          { target: 'events', entity: 'order-events', body: 'x', duplicateDetection: true },
          { retry },
        ),
      ],
      { environment: targetEnvironment() },
    );
    await submit(h1.container, run1);
    await execute(h1, run1.id);
    expect((await h1.container.infra.runs.getRun(run1.id))?.status).toBe('Succeeded');
    expect(safe.messages.map((message) => message.messageId)).toEqual([
      `${run1.id}-send`,
      `${run1.id}-send`,
    ]);
    expect((await stepRuns(h1.container, run1.id)).map((step) => step.status)).toEqual([
      'Retrying',
      'Succeeded',
    ]);

    const unsafe = fakes();
    unsafe.sendFailures = { count: 1, error: transient };
    const h2 = await createHarness({ env, targetClients: unsafe.clients });
    const run2 = makeRun(
      [
        node(
          'send',
          'serviceBus.send',
          { target: 'events', entity: 'order-events', body: 'x' },
          { retry },
        ),
      ],
      { environment: targetEnvironment() },
    );
    await submit(h2.container, run2);
    await execute(h2, run2.id);
    expect((await h2.container.infra.runs.getRun(run2.id))?.status).toBe('Failed');
    expect(unsafe.messages).toHaveLength(1);
    expect(await everything(h2, run2.id)).not.toContain(SB_KEY);
  });

  it('refuses a Step whose request is outside the Environment, before any client is used', async () => {
    const f = fakes();
    const h = await createHarness({ env, targetClients: f.clients });
    const run = makeRun(
      [node('send', 'serviceBus.send', { target: 'events', entity: 'other-queue', body: 'x' })],
      { environment: targetEnvironment() },
    );
    await submit(h.container, run);
    await execute(h, run.id);
    expect((await h.container.infra.runs.getRun(run.id))?.status).toBe('Failed');
    expect(f.opened).toHaveLength(0);
    const [step] = await stepRuns(h.container, run.id);
    expect(step?.error?.code).toBe('VALIDATION_TARGET_POLICY');
  });
});
