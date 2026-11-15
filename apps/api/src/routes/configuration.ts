import type { FastifyInstance } from 'fastify';
import { LOCAL_SECRET_NAME_PATTERN } from '@test-platform/contracts';
import type { Container } from '../container.js';
import { identityOf } from '../security.js';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,62}$' } },
} as const;

const writeBody = {
  type: 'object',
  required: ['environment', 'revision'],
  additionalProperties: false,
  properties: {
    // Validated in full by the service (schema, safe targets, secret provider policy).
    environment: { type: 'object' },
    revision: { type: 'string', minLength: 1, maxLength: 64 },
  },
} as const;

const revisionQuery = {
  type: 'object',
  required: ['revision'],
  additionalProperties: false,
  properties: { revision: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

const secretParams = {
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string', pattern: LOCAL_SECRET_NAME_PATTERN } },
} as const;

const secretBody = {
  type: 'object',
  required: ['value'],
  additionalProperties: false,
  // The service enforces the exact size in bytes; this keeps an oversized body out early.
  properties: { value: { type: 'string', minLength: 1, maxLength: 16_384 } },
} as const;

/**
 * Configuration management: Environments (hosts, allowlists, secret *references*) and secrets.
 * Secret values are write-only: no endpoint returns one, and none is ever echoed or audited.
 */
export const registerConfigurationRoutes = (api: FastifyInstance, container: Container): void => {
  const { environmentConfigs, secrets } = container;

  api.get('/environment-configs', async () => environmentConfigs.list());

  api.post<{ Body: { environment: unknown; revision: string } }>(
    '/environment-configs',
    { schema: { body: writeBody } },
    async (request, reply) => {
      const result = await environmentConfigs.create(
        request.body.environment,
        request.body.revision,
        identityOf(request).id,
      );
      return reply.status(201).send(result);
    },
  );

  api.put<{ Params: { id: string }; Body: { environment: unknown; revision: string } }>(
    '/environment-configs/:id',
    { schema: { params: idParams, body: writeBody } },
    async (request) =>
      environmentConfigs.update(
        request.params.id,
        request.body.environment,
        request.body.revision,
        identityOf(request).id,
      ),
  );

  api.delete<{ Params: { id: string }; Querystring: { revision: string } }>(
    '/environment-configs/:id',
    { schema: { params: idParams, querystring: revisionQuery } },
    async (request) =>
      environmentConfigs.remove(request.params.id, request.query.revision, identityOf(request).id),
  );

  api.get('/secrets', async () => secrets.overview());

  api.put<{ Params: { name: string }; Body: { value: string } }>(
    '/secrets/local/:name',
    { schema: { params: secretParams, body: secretBody } },
    async (request) =>
      secrets.setLocal(request.params.name, request.body.value, identityOf(request).id),
  );

  api.delete<{ Params: { name: string } }>(
    '/secrets/local/:name',
    { schema: { params: secretParams } },
    async (request, reply) => {
      await secrets.removeLocal(request.params.name, identityOf(request).id);
      return reply.status(204).send();
    },
  );
};
