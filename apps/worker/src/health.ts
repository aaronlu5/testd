import { access, constants } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { loadMigrations } from '@test-platform/infrastructure-local';
import type { WorkerContainer } from './container.js';

/** Point-in-time queue and state gauges; counts only, never identifiers or payloads. */
export const collectGauges = (
  infra: Pick<WorkerContainer['infra'], 'db'>,
): { name: string; value: number; labels?: Record<string, string> }[] => {
  const count = (sql: string): number => Number((infra.db.prepare(sql).get() as { n: number }).n);
  return [
    {
      name: 'platform_jobs_queued',
      value: count("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'"),
    },
    {
      name: 'platform_jobs_leased',
      value: count("SELECT COUNT(*) AS n FROM jobs WHERE status = 'leased'"),
    },
    {
      name: 'platform_runs_paused',
      value: count("SELECT COUNT(*) AS n FROM runs WHERE status = 'Paused'"),
    },
    {
      name: 'platform_runs_running',
      value: count("SELECT COUNT(*) AS n FROM runs WHERE status = 'Running'"),
    },
    {
      name: 'platform_suite_runs_active',
      value: count(
        "SELECT COUNT(*) AS n FROM suite_runs WHERE status NOT IN ('Succeeded','Failed','Cancelled')",
      ),
    },
  ];
};

export type ReadinessReport = { ready: boolean; checks: Record<string, 'ok' | 'failed'> };

/** Checks local dependencies without exposing paths or error text. */
export const checkReadiness = async (
  container: Pick<WorkerContainer, 'config' | 'infra' | 'loop' | 'clock'>,
): Promise<ReadinessReport> => {
  const { config, infra, loop, clock } = container;
  const attempt = async (work: () => Promise<unknown> | unknown): Promise<'ok' | 'failed'> => {
    try {
      await work();
      return 'ok';
    } catch {
      return 'failed';
    }
  };

  const staleAfterMs = Math.max(config.pollIntervalMs * 5, config.reaperIntervalMs, 30_000);
  const checks: ReadinessReport['checks'] = {
    database: await attempt(() => {
      const row = infra.db
        .prepare('SELECT MAX(version) AS version FROM schema_migrations')
        .get() as { version: number };
      if (row.version !== loadMigrations().length) throw new Error('schema version mismatch');
    }),
    runtime: await attempt(() =>
      Promise.all(
        ['artifacts', 'logs'].map((dir) =>
          access(join(config.runtimeDir, dir), constants.R_OK | constants.W_OK),
        ),
      ),
    ),
    loop: await attempt(() => {
      const last = loop.lastPollAt;
      if (last === undefined || clock.now().getTime() - last > staleAfterMs)
        throw new Error('worker loop is not polling');
    }),
  };
  return { ready: Object.values(checks).every((value) => value === 'ok'), checks };
};

/** Liveness and readiness only; the worker serves no control-plane routes. */
export const createHealthServer = (
  container: Pick<WorkerContainer, 'config' | 'infra' | 'loop' | 'clock'> &
    Partial<Pick<WorkerContainer, 'metrics'>>,
): Server =>
  createServer((request, response) => {
    const send = (status: number, body: unknown): void => {
      response.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(body));
    };
    const path = (request.url ?? '').split('?')[0];
    if (request.method !== 'GET') return send(405, { status: 'method-not-allowed' });
    if (path === '/health/live') return send(200, { status: 'alive' });
    if (path === '/metrics') {
      try {
        const body = container.metrics?.render(collectGauges(container.infra)) ?? '';
        response.writeHead(200, {
          'content-type': 'text/plain; version=0.0.4',
          'cache-control': 'no-store',
        });
        response.end(body);
      } catch {
        send(503, { status: 'unavailable' });
      }
      return;
    }
    if (path === '/health/ready') {
      void checkReadiness(container).then(
        (report) =>
          send(report.ready ? 200 : 503, {
            status: report.ready ? 'ready' : 'unavailable',
            checks: report.checks,
          }),
        () => send(503, { status: 'unavailable' }),
      );
      return;
    }
    return send(404, { status: 'not-found' });
  });
