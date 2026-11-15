import { SUITE_RUN_STATUSES, type SuiteRunUpdatedEvent } from '@test-platform/contracts';
import { isTerminalSuiteRunStatus } from '@test-platform/core';
import { SAFE_ID } from '@test-platform/infrastructure-local';
import type { FastifyInstance } from 'fastify';
import type { SuiteRunStatus } from '@test-platform/contracts';
import { redactValue } from '@test-platform/core';
import type { Container } from '../container.js';
import { identityOf } from '../security.js';
import type { CreateSuiteRunInput } from '../services/suite-run-service.js';
import { idParam, parseIntQuery } from './assets.js';
import { serveEventStream } from './sse.js';

const createBody = {
  type: 'object',
  required: ['suiteId', 'environmentId'],
  additionalProperties: false,
  properties: {
    suiteId: { type: 'string', pattern: SAFE_ID.source },
    suiteVersion: { type: 'integer', minimum: 1 },
    environmentId: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,62}$' },
    maxConcurrency: { type: 'integer', minimum: 1, maximum: 64 },
    variableOverrides: { type: 'object' },
  },
} as const;

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { enum: [...SUITE_RUN_STATUSES] },
    limit: { type: 'string', pattern: '^[0-9]+$' },
    offset: { type: 'string', pattern: '^[0-9]+$' },
  },
} as const;

const eventsQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { lastEventId: { type: 'string', pattern: '^[0-9]+$' } },
} as const;

/**
 * Suite Runs: a parent record whose child Test Runs are created by the worker scheduler.
 * Nothing here runs a Step; the API validates, stores snapshots, and reports state.
 */
export const registerSuiteRunRoutes = (api: FastifyInstance, container: Container): void => {
  const { suiteRuns, infra } = container;
  const mask = <T>(value: T): T =>
    redactValue(value, {
      secretValues: infra.secrets.sensitiveValues(),
      maskSensitiveKeys: false,
    }) as T;

  api.post<{ Body: CreateSuiteRunInput }>(
    '/suite-runs',
    { schema: { body: createBody } },
    async (request, reply) => {
      const created = await suiteRuns.create(request.body, identityOf(request).id);
      reply.header('Location', `/api/v1/suite-runs/${created.id}`);
      return reply.status(202).send(mask(created));
    },
  );

  api.get<{ Querystring: Record<string, string> }>(
    '/suite-runs',
    { schema: { querystring: listQuery } },
    async (request) => {
      const { limit, offset, status } = request.query;
      return {
        items: await suiteRuns.list({
          ...(status ? { status: status as SuiteRunStatus } : {}),
          limit: parseIntQuery(limit, 'limit', 1, 100) ?? 50,
          offset: parseIntQuery(offset, 'offset'),
        }),
      };
    },
  );

  /** Full parent and ordered children; the recovery point for a client that lost its stream. */
  api.get<{ Params: { id: string } }>(
    '/suite-runs/:id',
    { schema: { params: idParam } },
    async (request) => mask(await suiteRuns.get(request.params.id)),
  );

  api.post<{ Params: { id: string } }>(
    '/suite-runs/:id/cancel',
    { schema: { params: idParam } },
    async (request, reply) =>
      reply
        .status(202)
        .send(mask(await suiteRuns.cancel(request.params.id, identityOf(request).id))),
  );

  api.post<{ Params: { id: string } }>(
    '/suite-runs/:id/rerun',
    { schema: { params: idParam } },
    async (request, reply) => {
      const created = await suiteRuns.rerun(request.params.id, identityOf(request).id);
      reply.header('Location', `/api/v1/suite-runs/${created.id}`);
      return reply.status(202).send(mask(created));
    },
  );

  const shutdown = new AbortController();
  api.addHook('preClose', async () => shutdown.abort());

  api.get<{ Params: { id: string }; Querystring: { lastEventId?: string } }>(
    '/suite-runs/:id/events',
    { schema: { params: idParam, querystring: eventsQuery } },
    async (request, reply) => {
      const { id } = request.params;
      await suiteRuns.get(id);
      const header = request.headers['last-event-id'];
      const headerValue = Array.isArray(header) ? header[0] : header;
      await serveEventStream<SuiteRunUpdatedEvent>(request, reply, {
        container,
        shutdown: shutdown.signal,
        mask,
        lastSeq: parseIntQuery(request.query.lastEventId ?? headerValue, 'Last-Event-ID') ?? 0,
        source: {
          status: () => suiteRuns.currentStatus(id),
          events: (after, limit) => suiteRuns.events(id, after, limit),
          isTerminal: (status) => isTerminalSuiteRunStatus(status as SuiteRunStatus),
        },
      });
    },
  );
};
