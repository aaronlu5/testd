import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type ApiConfig } from '../src/config.js';
import { createContainer, type Container } from '../src/container.js';

export const SECRET = 'super-secret-value-123';

export const ENVIRONMENTS = {
  environments: [
    {
      id: 'local-test',
      name: 'Local test environment',
      classification: 'TEST',
      limits: { maxStepTimeoutSeconds: 60, maxRetryAttempts: 3 },
      values: { region: 'eu' },
      targets: {
        'example-api': {
          kind: 'http',
          baseUrl: 'https://example.invalid/api',
          allowedPaths: ['/orders/*'],
          secretRef: 'api-key',
        },
      },
    },
  ],
};

const cleanups: (() => Promise<void> | void)[] = [];

export const cleanupAll = async (): Promise<void> => {
  while (cleanups.length > 0) await cleanups.pop()?.();
};

export type TestApp = {
  dir: string;
  config: ApiConfig;
  container: Container;
  app: Awaited<ReturnType<typeof buildApp>>;
  request: (options: InjectOptions) => Promise<LightMyRequestResponse>;
  json: <T = unknown>(response: LightMyRequestResponse) => T;
};

export type TestAppOptions = {
  env?: Record<string, string | undefined>;
  environments?: unknown | null;
  logger?: Parameters<typeof buildApp>[0]['logger'];
  logStream?: NodeJS.WritableStream;
};

export const createTestApp = async (options: TestAppOptions = {}): Promise<TestApp> => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-api-'));
  await mkdir(join(dir, 'config'));
  if (options.environments !== null) {
    await writeFile(
      join(dir, 'config', 'environments.local.json'),
      JSON.stringify(options.environments ?? ENVIRONMENTS),
    );
  }

  const config = loadConfig(
    {
      TEST_PLATFORM_RUNTIME_DIR: join(dir, 'runtime'),
      TEST_PLATFORM_DEFINITIONS_DIR: join(dir, 'definitions'),
      TEST_PLATFORM_CONFIG_DIR: join(dir, 'config'),
      TEST_PLATFORM_API_SSE_POLL_MS: '20',
      TEST_PLATFORM_API_SSE_HEARTBEAT_MS: '100',
      TEST_PLATFORM_LOG_LEVEL: 'error',
      TEST_PLATFORM_SECRET_API_KEY: SECRET,
      ...options.env,
    },
    dir,
  );
  const container = await createContainer(config);
  const app = await buildApp({
    config,
    container,
    logger: options.logStream ? undefined : (options.logger ?? false),
    logStream: options.logStream,
  });
  await app.ready();

  cleanups.push(async () => {
    await app.close();
    container.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  return {
    dir,
    config,
    container,
    app,
    request: (opts) => app.inject(opts),
    json: <T>(response: LightMyRequestResponse) => response.json() as T,
  };
};

export const testBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'Order processing happy path',
  description: 'Delays, shapes, and asserts.',
  tags: ['orders'],
  variables: { orderId: '{{testData.order.id}}' },
  nodes: [
    { id: 'wait', type: 'delay', name: 'Wait', parameters: { durationSeconds: 0.01 } },
    {
      id: 'shape',
      type: 'transform.json',
      name: 'Shape',
      parameters: { input: '{{testData.order}}', mapping: { id: '$.id' } },
    },
    {
      id: 'verify',
      type: 'assert',
      name: 'Verify',
      parameters: {
        actual: '{{steps.shape.output.id}}',
        operator: 'equals',
        expected: '{{variables.orderId}}',
      },
    },
  ],
  edges: [
    { from: 'wait', to: 'shape' },
    { from: 'shape', to: 'verify' },
  ],
  ...overrides,
});

export const dataBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'Valid order',
  tags: ['orders'],
  data: { order: { id: 'ORD-1', customerId: 'CUS-1' } },
  ...overrides,
});

export const ids = {
  create: async (
    t: TestApp,
    path: string,
    body: unknown,
  ): Promise<{ id: string; version: number }> => {
    const response = await t.request({
      method: 'POST',
      url: `/api/v1/${path}`,
      payload: body as object,
    });
    if (response.statusCode !== 201)
      throw new Error(`create ${path} failed: ${response.statusCode} ${response.body}`);
    return t.json(response);
  },
};

export const seedRunInputs = async (t: TestApp) => {
  const test = await ids.create(t, 'tests', testBody());
  const data = await ids.create(t, 'test-data', dataBody());
  return { testId: test.id, dataSetId: data.id, environmentId: 'local-test' };
};
