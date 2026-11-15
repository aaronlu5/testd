import type { FastifyInstance } from 'fastify';
import { checkReadiness, type Container } from './container.js';

/** Liveness always answers; readiness reflects local dependencies (database, folders, environments). */
export const registerHealthRoutes = (
  app: FastifyInstance,
  container: Container | undefined,
): void => {
  app.get('/health/live', async () => ({ status: 'alive' }));

  app.get('/health/ready', async (_request, reply) => {
    if (!container) {
      return reply.status(503).send({ status: 'unavailable', checks: { startup: 'failed' } });
    }
    const report = await checkReadiness(container);
    return reply.status(report.ready ? 200 : 503).send({
      status: report.ready ? 'ready' : 'unavailable',
      checks: report.checks,
      ...(report.secrets ? { secrets: report.secrets } : {}),
    });
  });
};
