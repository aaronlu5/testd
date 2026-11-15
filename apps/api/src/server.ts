import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createContainer, type Container } from './container.js';

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

  let container: Container | undefined;
  let startupFailure: unknown;
  try {
    container = await createContainer(config);
  } catch (error) {
    // Stay up in degraded mode so /health/ready can report the failure cleanly.
    startupFailure = error;
  }

  const app = await buildApp({ config, container });
  if (startupFailure) {
    app.log.error(
      { err: startupFailure },
      'A local dependency is unavailable; serving health endpoints only',
    );
  } else if (container) {
    app.log.info({ reconcile: container.startup.reconcile }, 'Definitions reconciled');
    if (container.startup.reconcile.invalid > 0) {
      app.log.warn(
        { invalid: container.startup.reconcile.invalid },
        'Some definition files are invalid and were not indexed',
      );
    }
  }

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, 'Shutting down');
    await app.close();
    container?.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
