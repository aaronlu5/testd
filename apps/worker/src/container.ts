import {
  MockApiRegistry,
  createMetricsRegistry,
  systemClock,
  type Clock,
  type MetricsRegistry,
  type TargetClients,
} from '@test-platform/core';
import {
  createTargetClients,
  openLocalInfrastructure,
  type LocalInfrastructure,
  type LogSink,
} from '@test-platform/infrastructure-local';
import { StepRegistry, createBuiltInRegistry } from '@test-platform/step-sdk';
import type { WorkerConfig } from './config.js';
import { InspectorService } from './inspector-service.js';
import { RunExecutor } from './run-executor.js';
import { SuiteScheduler } from './suite-scheduler.js';
import { WorkerLoop } from './worker-loop.js';

export type WorkerContainer = {
  config: WorkerConfig;
  infra: LocalInfrastructure;
  registry: StepRegistry;
  clock: Clock;
  metrics: MetricsRegistry;
  executor: RunExecutor;
  /** The Mock API setups that are live right now; served by the Mock API server. */
  mocks: MockApiRegistry;
  scheduler: SuiteScheduler;
  inspector: InspectorService;
  loop: WorkerLoop;
  close(): void;
};

export type ContainerOverrides = {
  clock?: Clock;
  registry?: StepRegistry;
  /** Replaces the Azure/HTTP clients; tests inject fakes so nothing leaves the process. */
  targetClients?: TargetClients;
  logSink?: LogSink;
};

/**
 * Creates directories, opens SQLite and applies migrations, and registers built-in Step types.
 * The worker reads definitions only through Run snapshots, never from the definition files.
 */
export const createContainer = (
  config: WorkerConfig,
  overrides: ContainerOverrides = {},
): WorkerContainer => {
  const clock = overrides.clock ?? systemClock;
  const infra = openLocalInfrastructure({
    runtimeDir: config.runtimeDir,
    definitionsDir: config.definitionsDir,
    env: config.env,
    clock,
    logLevel: config.logLevel,
    logSink: overrides.logSink,
    maxArtifactBytes: config.maxArtifactBytes,
    inspectorMaxMessages: config.inspectorMaxMessages,
  });
  try {
    const registry = overrides.registry ?? createBuiltInRegistry();
    const logger = infra.logger.child({ component: 'worker', workerId: config.workerId });
    const metrics = createMetricsRegistry();
    const clients = overrides.targetClients ?? createTargetClients();
    const mocks = new MockApiRegistry();
    const executor = new RunExecutor({
      mocks,
      metrics,
      config,
      infra,
      registry,
      clock,
      logger,
      clients,
    });
    const scheduler = new SuiteScheduler({ infra, logger, metrics });
    const inspector = new InspectorService({
      infra,
      clients,
      clock,
      logger,
      metrics,
      environmentsFile: config.environmentsFile,
      pollMs: config.inspectorPollMs,
    });
    const loop = new WorkerLoop({ config, infra, executor, scheduler, clock, logger, metrics });
    return {
      config,
      infra,
      registry,
      clock,
      metrics,
      executor,
      mocks,
      scheduler,
      inspector,
      loop,
      close: () => infra.close(),
    };
  } catch (error) {
    infra.close();
    throw error;
  }
};
