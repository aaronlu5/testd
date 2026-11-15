import { redactValue } from '@test-platform/core';
import type { FastifyInstance } from 'fastify';
import type { InspectorWatchInput } from '@test-platform/contracts';
import type { Container } from '../container.js';
import { identityOf } from '../security.js';
import { parseIntQuery } from './assets.js';

const watchBody = {
  type: 'object',
  required: ['environmentId', 'target', 'entity'],
  additionalProperties: false,
  properties: {
    environmentId: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,62}$' },
    target: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' },
    entity: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._/-]{0,259}$' },
    subscription: { type: 'string', minLength: 1, maxLength: 50 },
  },
} as const;

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: '^[A-Za-z0-9-]{1,64}$' } },
} as const;

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'string', pattern: '^[0-9]+$' },
    before: { type: 'string', pattern: '^[0-9]+$' },
    watchId: { type: 'string', pattern: '^[A-Za-z0-9-]{1,64}$' },
  },
} as const;

const viewedBody = {
  type: 'object',
  required: ['upToSeq'],
  additionalProperties: false,
  properties: { upToSeq: { type: 'integer', minimum: 0 } },
} as const;

/**
 * Service Bus Inspector. Messages are already masked when stored; they are masked again here as
 * a last line of defence. Nothing in this API sends, receives or deletes a Service Bus message.
 */
export const registerInspectorRoutes = (api: FastifyInstance, container: Container): void => {
  const { inspector, infra } = container;
  const mask = <T>(value: T): T =>
    redactValue(value, {
      secretValues: infra.secrets.sensitiveValues(),
      maskSensitiveKeys: false,
    }) as T;

  api.get('/inspector', async () => mask(inspector.summary()));

  api.post<{ Body: InspectorWatchInput }>(
    '/inspector/watches',
    { schema: { body: watchBody } },
    async (request, reply) => {
      const watch = await inspector.addWatch(request.body, identityOf(request).id);
      return reply.status(201).send(watch);
    },
  );

  api.delete<{ Params: { id: string } }>(
    '/inspector/watches/:id',
    { schema: { params: idParams } },
    async (request, reply) => {
      await inspector.removeWatch(request.params.id, identityOf(request).id);
      return reply.status(204).send();
    },
  );

  api.get<{ Querystring: { limit?: string; before?: string; watchId?: string } }>(
    '/inspector/messages',
    { schema: { querystring: listQuery } },
    async (request) =>
      mask(
        inspector.list({
          limit: parseIntQuery(request.query.limit, 'limit', 1, 500),
          before: parseIntQuery(request.query.before, 'before'),
          watchId: request.query.watchId,
        }),
      ),
  );

  api.get<{ Params: { id: string } }>(
    '/inspector/messages/:id',
    { schema: { params: idParams } },
    async (request) => mask(inspector.get(request.params.id)),
  );

  api.post('/inspector/clear', async (request) => inspector.clear(identityOf(request).id));

  api.post<{ Body: { upToSeq: number } }>(
    '/inspector/viewed',
    { schema: { body: viewedBody } },
    async (request, reply) => {
      inspector.markViewed(request.body.upToSeq);
      return reply.status(204).send();
    },
  );
};
