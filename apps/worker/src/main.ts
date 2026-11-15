import { isTerminalRunStatus } from '@test-platform/core';
import { ConfigError, loadConfig } from './config.js';
import { createContainer } from './container.js';
import { createHealthServer } from './health.js';
import { createMockApiServer } from './mock-api-server.js';

const main = async (): Promise<void> => {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const container = createContainer(config);
  const logger = container.infra.logger.child({ component: 'worker', workerId: config.workerId });
  logger.info('Worker starting', { migrations: container.infra.migration });

  const health = createHealthServer(container);
  await new Promise<void>((resolve, reject) => {
    health.once('error', reject);
    health.listen(config.healthPort, '127.0.0.1', () => resolve());
  });
  const mockApi = createMockApiServer({
    registry: container.mocks,
    log: container.infra.mockApi,
    logger: logger.child({ component: 'mock-api' }),
    isRunActive: async (runId) => {
      const run = await container.infra.runs.getRun(runId);
      return run !== undefined && !isTerminalRunStatus(run.status);
    },
  });
  // Runs do not depend on the Mock API server, so a busy port is reported, not fatal.
  const mockApiStartedAt = new Date().toISOString();
  const reportMockApi = (listening: boolean, error?: string): void => {
    try {
      container.infra.mockApi.heartbeat({
        listening,
        host: config.mockApiHost,
        port: config.mockApiPort,
        ...(listening ? { startedAt: mockApiStartedAt } : {}),
        activeRuns: container.mocks.activeRuns.length,
        ...(error ? { error } : {}),
      });
    } catch (failure) {
      logger.warn('Could not record the Mock API server status', {
        error: failure instanceof Error ? failure.message : 'unknown',
      });
    }
  };
  let mockApiListening = false;
  await new Promise<void>((resolve) => {
    mockApi.once('error', (error: Error) => {
      logger.error('The Mock API server could not start; Runs continue without it', {
        host: config.mockApiHost,
        port: config.mockApiPort,
        error: error.message,
      });
      reportMockApi(false, error.message);
      resolve();
    });
    mockApi.listen(config.mockApiPort, config.mockApiHost, () => {
      mockApiListening = true;
      logger.info('Mock API server listening', {
        host: config.mockApiHost,
        port: config.mockApiPort,
      });
      reportMockApi(true);
      resolve();
    });
  });
  // The API reads this to show whether the server is up; it counts as down once it goes quiet.
  const mockApiBeat = mockApiListening ? setInterval(() => reportMockApi(true), 5_000) : undefined;
  mockApiBeat?.unref();
  container.loop.start();
  container.inspector.start();

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info('Shutting down', { signal });
    try {
      await container.inspector.stop();
      await container.loop.stop();
    } finally {
      if (mockApiBeat) clearInterval(mockApiBeat);
      if (mockApiListening) reportMockApi(false, 'The worker stopped.');
      health.close();
      mockApi.close();
      container.close();
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
