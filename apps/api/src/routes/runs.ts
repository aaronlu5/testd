import { PlatformError, isTerminalRunStatus, redactValue } from '@test-platform/core';
import { RUN_KINDS, RUN_STATUSES, type RunEvent, type RunStatus } from '@test-platform/contracts';
import { SAFE_ID } from '@test-platform/infrastructure-local';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../container.js';
import { identityOf } from '../security.js';
import type { CreateRunInput } from '../services/run-service.js';
import { idParam, parseIntQuery } from './assets.js';
import { serveEventStream } from './sse.js';

const createRunBody = {
  type: 'object',
  required: ['testId', 'dataSetId', 'environmentId'],
  additionalProperties: false,
  properties: {
    testId: { type: 'string', pattern: SAFE_ID.source },
    testVersion: { type: 'integer', minimum: 1 },
    dataSetId: { type: 'string', pattern: SAFE_ID.source },
    dataSetVersion: { type: 'integer', minimum: 1 },
    environmentId: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,62}$' },
    variableOverrides: { type: 'object' },
  },
} as const;

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { enum: [...RUN_STATUSES] },
    kind: { enum: [...RUN_KINDS] },
    testId: { type: 'string', pattern: SAFE_ID.source },
    environmentId: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,62}$' },
    limit: { type: 'string', pattern: '^[0-9]+$' },
    offset: { type: 'string', pattern: '^[0-9]+$' },
  },
} as const;

/** The body is optional, so it is checked here: only `continuationGeneration` is accepted. */
const parseResumeBody = (body: unknown): { continuationGeneration?: number } => {
  if (body === undefined || body === null) return {};
  const fail = (path: string, message: string): never => {
    throw new PlatformError('VALIDATION_SCHEMA', 'The request body is not valid.', {
      issues: [{ path, message }],
    });
  };
  if (typeof body !== 'object' || Array.isArray(body)) return fail('', 'must be a JSON object');
  const { continuationGeneration, ...rest } = body as Record<string, unknown>;
  for (const key of Object.keys(rest))
    fail(`/${key}`, 'is not accepted; resume takes no overrides');
  if (
    continuationGeneration !== undefined &&
    !(Number.isInteger(continuationGeneration) && (continuationGeneration as number) >= 0)
  ) {
    fail('/continuationGeneration', 'must be a non-negative integer');
  }
  return { continuationGeneration: continuationGeneration as number | undefined };
};

const stepParams = {
  type: 'object',
  required: ['id', 'stepRunId'],
  properties: {
    id: { type: 'string', pattern: SAFE_ID.source },
    stepRunId: { type: 'string', pattern: SAFE_ID.source },
  },
} as const;

const eventsQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { lastEventId: { type: 'string', pattern: '^[0-9]+$' } },
} as const;

export const registerRunRoutes = (api: FastifyInstance, container: Container): void => {
  const { runs, queries, infra } = container;
  const mask = <T>(value: T): T =>
    redactValue(value, {
      secretValues: infra.secrets.sensitiveValues(),
      maskSensitiveKeys: false,
    }) as T;

  api.post<{ Body: CreateRunInput }>(
    '/runs',
    { schema: { body: createRunBody } },
    async (request, reply) => {
      const run = await runs.create(request.body, identityOf(request).id);
      reply.header('Location', `/api/v1/runs/${run.id}`);
      return reply.status(202).send(run);
    },
  );

  api.get<{ Querystring: Record<string, string> }>(
    '/runs',
    { schema: { querystring: listQuery } },
    async (request) => {
      const { limit, offset, ...filters } = request.query;
      return {
        items: await queries.list({
          ...filters,
          limit: parseIntQuery(limit, 'limit', 1, 100) ?? 50,
          offset: parseIntQuery(offset, 'offset'),
        }),
      };
    },
  );

  api.get<{ Params: { id: string } }>(
    '/runs/:id',
    { schema: { params: idParam } },
    async (request) => mask(await queries.detail(request.params.id)),
  );

  api.get<{ Params: { id: string; stepRunId: string } }>(
    '/runs/:id/steps/:stepRunId',
    { schema: { params: stepParams } },
    async (request) => mask(await queries.stepRun(request.params.id, request.params.stepRunId)),
  );

  api.post<{ Params: { id: string } }>(
    '/runs/:id/cancel',
    { schema: { params: idParam } },
    async (request, reply) =>
      reply.status(202).send(await runs.cancel(request.params.id, identityOf(request).id)),
  );

  /**
   * The active Breakpoint pause and the Steps completed before it, for read-only inspection.
   * 404 unless the Run is paused. Everything returned is already masked and size-capped; artifacts
   * are referenced by id and streamed through `/artifacts/:id`, never by a local path.
   */
  api.get<{ Params: { id: string } }>(
    '/runs/:id/pause',
    { schema: { params: idParam } },
    async (request) => mask(await queries.pauseInspection(request.params.id)),
  );

  /**
   * Resumes a paused Run from its immutable snapshot. The optional body names the continuation
   * generation that was inspected; a stale one is a 409. Repeating an accepted resume returns 202
   * again without queueing anything. No overrides, input edits or Environment changes are accepted.
   */
  api.post<{ Params: { id: string }; Body: unknown }>(
    '/runs/:id/resume',
    { schema: { params: idParam } },
    async (request, reply) => {
      const result = await runs.resume(
        request.params.id,
        identityOf(request).id,
        parseResumeBody(request.body).continuationGeneration,
      );
      return reply.status(202).send(result);
    },
  );

  api.post<{ Params: { id: string } }>(
    '/runs/:id/rerun',
    { schema: { params: idParam } },
    async (request, reply) => {
      const run = await runs.rerun(request.params.id, identityOf(request).id);
      reply.header('Location', `/api/v1/runs/${run.id}`);
      return reply.status(202).send(run);
    },
  );

  // Open SSE connections are ended before the server stops accepting; otherwise `close()` would
  // wait on them forever.
  const shutdown = new AbortController();
  api.addHook('preClose', async () => shutdown.abort());

  /**
   * Server-Sent Events backed by the persisted `run_events` feed, so events written by the worker
   * process are delivered. Clients resume with `Last-Event-ID`. The stream ends once the Run is
   * terminal and its events are drained; the worker must publish events before the terminal
   * transition for that to be loss-free.
   */
  api.get<{ Params: { id: string }; Querystring: { lastEventId?: string } }>(
    '/runs/:id/events',
    { schema: { params: idParam, querystring: eventsQuery } },
    async (request, reply) => {
      const { id } = request.params;
      await queries.requireRun(id);

      const header = request.headers['last-event-id'];
      const headerValue = Array.isArray(header) ? header[0] : header;
      await serveEventStream<RunEvent>(request, reply, {
        container,
        shutdown: shutdown.signal,
        mask,
        lastSeq: parseIntQuery(request.query.lastEventId ?? headerValue, 'Last-Event-ID') ?? 0,
        source: {
          status: () => queries.currentStatus(id),
          events: (after, limit) => queries.events(id, after, limit),
          // A Paused Run is not terminal: the stream stays open until it is resumed or cancelled.
          isTerminal: (status) => isTerminalRunStatus(status as RunStatus),
        },
      });
    },
  );
};
