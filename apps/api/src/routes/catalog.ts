import type { FastifyInstance } from 'fastify';
import { MOCK_API_HEARTBEAT_TTL_MS, type MockApiStatus } from '@test-platform/contracts';
import { GLOBAL_VARIABLES } from '@test-platform/core';
import type { Container } from '../container.js';
import { identityOf } from '../security.js';
import { idParam } from './assets.js';

/** Content types served inline; everything else is forced to a download as application/octet-stream. */
const INLINE_TYPES = new Set(['application/json', 'text/plain', 'text/csv']);

const mediaType = (contentType: string): string =>
  contentType.split(';')[0]?.trim().toLowerCase() ?? '';
const SAFE_CONTENT_TYPE = /^[\w.+-]+\/[\w.+-]+(; ?charset=[\w-]+)?$/i;

export const registerCatalogRoutes = (api: FastifyInstance, container: Container): void => {
  api.get('/step-types', async () => ({ items: container.registry.describe() }));

  // Where the SUT reaches the Mock API server, so it can be shown next to the setups.
  api.get('/helpers/mock-api', async () => {
    const url = new URL(container.config.mockApiPublicUrl);
    return {
      baseUrl: container.config.mockApiPublicUrl,
      host: url.host,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? '443' : '80'),
    };
  });

  // Is the worker serving the Mock API server? It reports every few seconds; silence means down.
  api.get('/helpers/mock-api/status', async (): Promise<MockApiStatus> => {
    const baseUrl = container.config.mockApiPublicUrl;
    const state = container.infra.mockApi.state();
    const lastRequestId = container.infra.mockApi.list({ limit: 1 }).lastId;
    if (!state)
      return {
        running: false,
        baseUrl,
        activeRuns: 0,
        lastRequestId,
        message: 'The worker has not reported the Mock API server yet. Is the worker running?',
      };
    const age = Date.now() - Date.parse(state.heartbeatAt);
    const live = state.listening && age <= MOCK_API_HEARTBEAT_TTL_MS;
    return {
      running: live,
      baseUrl,
      ...(state.host ? { host: state.host } : {}),
      ...(state.port !== undefined ? { port: state.port } : {}),
      ...(state.startedAt ? { startedAt: state.startedAt } : {}),
      lastSeenAt: state.heartbeatAt,
      activeRuns: live ? state.activeRuns : 0,
      lastRequestId,
      ...(live
        ? {}
        : {
            message: state.listening
              ? 'The worker has stopped reporting; it may not be running.'
              : (state.error ?? 'The Mock API server is not listening.'),
          }),
    };
  });

  api.get<{ Querystring: { limit?: string } }>(
    '/helpers/mock-api/requests',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'string', pattern: '^[1-9][0-9]{0,2}$' } },
        },
      },
    },
    async (request) =>
      container.infra.mockApi.list({
        limit: request.query.limit === undefined ? undefined : Number(request.query.limit),
      }),
  );

  api.delete('/helpers/mock-api/requests', async (_request, reply) => {
    container.infra.mockApi.clear();
    return reply.status(204).send();
  });

  api.get('/globals', async () => ({ items: GLOBAL_VARIABLES }));

  api.get('/environments', async () => ({ items: await container.environments.list() }));
};

export const registerArtifactRoutes = (api: FastifyInstance, container: Container): void => {
  api.get<{ Params: { id: string } }>(
    '/artifacts/:id/metadata',
    { schema: { params: idParam } },
    async (request) => container.queries.artifactMetadata(identityOf(request), request.params.id),
  );

  api.get<{ Params: { id: string } }>(
    '/artifacts/:id',
    { schema: { params: idParam } },
    async (request, reply) => {
      const { artifact, content } = await container.queries.artifactContent(
        identityOf(request),
        request.params.id,
      );
      const inline =
        SAFE_CONTENT_TYPE.test(artifact.contentType) &&
        INLINE_TYPES.has(mediaType(artifact.contentType));

      return (
        reply
          .header('Content-Type', inline ? artifact.contentType : 'application/octet-stream')
          .header('Content-Length', content.byteLength)
          .header(
            'Content-Disposition',
            inline ? 'inline' : `attachment; filename="artifact-${artifact.id}"`,
          )
          // Stored content is untrusted; never let a browser render or script it from this origin.
          .header('Content-Security-Policy', "default-src 'none'; sandbox")
          .header('Cache-Control', 'private, no-store')
          .send(Buffer.from(content))
      );
    },
  );
};
