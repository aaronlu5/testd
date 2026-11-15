import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  EnvironmentConfig,
  Run,
  RunEvent,
  StepRun,
  TestDefinition,
  TestNode,
} from '@test-platform/contracts';
import type { Clock, TargetClients } from '@test-platform/core';
import { newId } from '@test-platform/infrastructure-local';
import {
  createBuiltInRegistry,
  type StepDefinition,
  type StepRegistry,
} from '@test-platform/step-sdk';
import { loadConfig, type WorkerConfig } from '../src/config.js';
import { createContainer, type WorkerContainer } from '../src/container.js';

export const SECRET = 'super-secret-value-123';

export class FakeClock implements Clock {
  ms: number;
  constructor(start = '2026-01-01T00:00:00.000Z') {
    this.ms = Date.parse(start);
  }
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

const cleanups: (() => Promise<void> | void)[] = [];
export const cleanupAll = async (): Promise<void> => {
  while (cleanups.length > 0) await cleanups.pop()?.();
};

export type Harness = {
  dir: string;
  config: WorkerConfig;
  container: WorkerContainer;
  logs: string[];
  /** Another worker process sharing the same database and runtime directory. */
  second: (workerId: string, registry?: StepRegistry) => WorkerContainer;
};

export type HarnessOptions = {
  env?: Record<string, string | undefined>;
  clock?: Clock;
  registry?: StepRegistry;
  targetClients?: TargetClients;
};

export const createHarness = async (options: HarnessOptions = {}): Promise<Harness> => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-worker-'));
  const env = {
    TEST_PLATFORM_RUNTIME_DIR: join(dir, 'runtime'),
    TEST_PLATFORM_DEFINITIONS_DIR: join(dir, 'definitions'),
    TEST_PLATFORM_CONFIG_DIR: join(dir, 'config'),
    TEST_PLATFORM_WORKER_ID: 'worker-a',
    TEST_PLATFORM_WORKER_POLL_MS: '10',
    TEST_PLATFORM_WORKER_CANCEL_POLL_MS: '10',
    TEST_PLATFORM_WORKER_REAPER_MS: '10',
    TEST_PLATFORM_WORKER_HEALTH_PORT: '0',
    TEST_PLATFORM_LOG_LEVEL: 'debug',
    TEST_PLATFORM_SECRET_API_KEY: SECRET,
    ...options.env,
  };
  const config = loadConfig(env, dir);
  const logs: string[] = [];
  const containers: WorkerContainer[] = [];
  const open = (cfg: WorkerConfig, registry?: StepRegistry): WorkerContainer => {
    const container = createContainer(cfg, {
      clock: options.clock,
      registry: registry ?? options.registry,
      targetClients: options.targetClients,
      logSink: (line) => logs.push(line),
    });
    containers.push(container);
    return container;
  };
  const container = open(config);
  cleanups.push(async () => {
    for (const item of containers) item.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return {
    dir,
    config,
    container,
    logs,
    second: (workerId, registry) => open({ ...config, workerId }, registry),
  };
};

export const environment = (overrides: Partial<EnvironmentConfig> = {}): EnvironmentConfig => ({
  id: 'local-test',
  name: 'Local test',
  classification: 'TEST',
  values: { region: 'eu' },
  targets: {},
  ...overrides,
});

export const node = (
  id: string,
  type: string,
  parameters: TestNode['parameters'] = {},
  execution?: TestNode['execution'],
): TestNode => ({
  id,
  type,
  name: id,
  parameters,
  ...(execution ? { execution } : {}),
});

export const chain = (...nodes: TestNode[]): Pick<TestDefinition, 'nodes' | 'edges'> => ({
  nodes,
  edges: nodes
    .slice(1)
    .map((next, index) => ({ from: (nodes[index] as TestNode).id, to: next.id })),
});

export const makeRun = (
  nodes: TestNode[],
  options: {
    environment?: EnvironmentConfig;
    variables?: TestDefinition['variables'];
    data?: Record<string, unknown>;
    overrides?: Run['variableOverrides'];
    status?: Run['status'];
  } = {},
): Run => {
  const at = '2026-01-01T00:00:00.000Z';
  const meta = { createdAt: at, createdBy: 'tester' };
  const test: TestDefinition = {
    schemaVersion: 1,
    id: 'test-1',
    version: 1,
    name: 'Test',
    tags: [],
    metadata: meta,
    variables: options.variables ?? {},
    ...chain(...nodes),
  };
  return {
    id: newId(),
    kind: 'test',
    status: options.status ?? 'Queued',
    environmentId: 'local-test',
    requestedBy: 'tester',
    requestedAt: at,
    test: { id: 'test-1', version: 1 },
    variableOverrides: options.overrides ?? {},
    snapshots: {
      test,
      testData: {
        schemaVersion: 1,
        id: 'data-1',
        version: 1,
        name: 'Data',
        tags: [],
        metadata: meta,
        data: (options.data ?? {}) as never,
      },
      environment: options.environment ?? environment(),
    },
  };
};

export const submit = async (container: WorkerContainer, run: Run) =>
  container.infra.commands.submit({ run });

export const stepRuns = (container: WorkerContainer, runId: string): Promise<StepRun[]> =>
  container.infra.runs
    .listStepRuns(runId)
    .then((rows) =>
      [...rows].sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.attempt - b.attempt),
    );

export const eventsOf = (container: WorkerContainer, runId: string): Promise<RunEvent[]> =>
  container.infra.events.listSince(runId);

export const runStatuses = (events: RunEvent[]): string[] =>
  events.flatMap((event) => (event.type === 'run.status' ? [event.data.status] : []));

export const waitFor = async <T>(
  probe: () => Promise<T | undefined | false> | T | undefined | false,
  timeoutMs = 5_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for a condition.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const anySchema = { type: 'object' } as const;

/** Built-in registry plus controllable Steps used to provoke failures. */
export type TestSteps = {
  /** `flaky` fails with a retryable error this many times before succeeding. */
  flakyFailures: number;
  flakyCalls: number;
  /** `gate` waits (abortably) while this is true. */
  hold: boolean;
  gateStarts: number;
  /** Invoked by the `hook` Step. */
  onHook?: (runId: string) => Promise<void>;
  externalCalls: number;
};

export const createTestRegistry = (state: TestSteps): StepRegistry => {
  const registry = createBuiltInRegistry();
  const base = {
    configSchema: anySchema,
    validate: () => [],
  } as const;

  const define = (
    step: Pick<StepDefinition<Record<string, unknown>>, 'type' | 'execute'> &
      Partial<StepDefinition<Record<string, unknown>>>,
  ): void => {
    registry.register({
      displayName: step.type,
      capabilities: { external: false, supportsRetry: true, supportsArtifacts: true },
      ...base,
      ...step,
    } as StepDefinition<Record<string, unknown>>);
  };

  define({
    type: 'flaky',
    async execute() {
      state.flakyCalls += 1;
      if (state.flakyCalls <= state.flakyFailures) {
        return {
          status: 'Failed',
          logs: [],
          error: { code: 'TARGET_SERVICE', message: 'The target is unavailable.' },
        };
      }
      return { status: 'Succeeded', logs: [], output: { calls: state.flakyCalls } };
    },
  });

  define({
    type: 'gate',
    async execute(context) {
      state.gateStarts += 1;
      while (state.hold) {
        if (context.signal.aborted) {
          return {
            status: 'Failed',
            logs: [],
            error: { code: 'EXECUTION_CANCELLED', message: 'x' },
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return { status: 'Succeeded', logs: [], output: { starts: state.gateStarts } };
    },
  });

  define({
    type: 'hook',
    async execute(context) {
      await state.onHook?.(context.correlation.runId);
      return { status: 'Succeeded', logs: [], output: null };
    },
  });

  define({
    type: 'external',
    capabilities: { external: true, supportsRetry: false, supportsArtifacts: false },
    async execute() {
      state.externalCalls += 1;
      return { status: 'Succeeded', logs: [], output: { ok: true } };
    },
  });

  define({
    type: 'big',
    async execute() {
      return { status: 'Succeeded', logs: [], output: { text: 'x'.repeat(5_000) } };
    },
  });

  define({
    type: 'leak',
    async execute(context, config) {
      const secret = (await context.secrets.getSecret('api-key')) as string;
      context.logger.info(`Authorization used ${secret}`, { token: secret, note: `v=${secret}` });
      await context.artifacts.write({ content: `body ${secret}`, contentType: 'text/plain' });
      if (config.fail === true) {
        return {
          status: 'Failed',
          logs: context.logger.entries(),
          output: { echoed: secret },
          error: { code: 'TARGET_REQUEST', message: `Rejected credential ${secret}` },
        };
      }
      return { status: 'Succeeded', logs: context.logger.entries(), output: { echoed: secret } };
    },
  });

  return registry;
};

export const newTestState = (): TestSteps => ({
  flakyFailures: 0,
  flakyCalls: 0,
  hold: false,
  gateStarts: 0,
  externalCalls: 0,
});
