import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import { createRedactor, type Redactor } from '@test-platform/core';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { ApiConfig } from './config.js';
import type { Container } from './container.js';
import { registerErrorHandling, unavailable } from './errors.js';
import { registerHealthRoutes } from './health.js';
import { registerArtifactRoutes, registerCatalogRoutes } from './routes/catalog.js';
import { registerAssetRoutes } from './routes/assets.js';
import { registerConfigurationRoutes } from './routes/configuration.js';
import { registerInspectorRoutes } from './routes/inspector.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerSuiteRunRoutes } from './routes/suite-runs.js';
import { registerValidationRoutes } from './routes/validation.js';
import { registerApiGuards, registerSecurityHeaders } from './security.js';

const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

export type BuildAppOptions = {
  config: ApiConfig;
  /** Omit to run in degraded mode: liveness answers, readiness and the API report unavailable. */
  container?: Container;
  /** Pass `false` to silence logging (tests) or Fastify logger options. */
  logger?: FastifyServerOptions['logger'];
  /** Destination for the default logger (tests); ignored when `logger` is given. */
  logStream?: NodeJS.WritableStream;
};

const loggerFor = (
  config: ApiConfig,
  stream?: NodeJS.WritableStream,
): FastifyServerOptions['logger'] => ({
  level: config.logLevel,
  ...(stream ? { stream } : {}),
  // Only path (never query string or headers) is logged for requests.
  serializers: {
    req: (request: { method?: string; url?: string; id?: string }) => ({
      method: request.method,
      path: request.url?.split('?')[0],
      requestId: request.id,
    }),
  },
  redact: {
    paths: [
      'headers.authorization',
      'headers.cookie',
      'req.headers.authorization',
      'req.headers.cookie',
    ],
    censor: '***REDACTED***',
  },
});

export const buildApp = async ({
  config,
  container,
  logger,
  logStream,
}: BuildAppOptions): Promise<FastifyInstance> => {
  const redactor: Redactor = container?.redactor ?? createRedactor({ secretValues: () => [] });

  const app = Fastify({
    logger: logger ?? loggerFor(config, logStream),
    // Accept a caller-supplied correlation id only when it is a short, log-safe token.
    genReqId: (request) => {
      const supplied = request.headers['x-request-id'];
      return typeof supplied === 'string' && REQUEST_ID.test(supplied) ? supplied : randomUUID();
    },
    requestIdHeader: false,
    bodyLimit: config.bodyLimitBytes,
    trustProxy: false,
    // Reject unknown properties instead of silently stripping them, and never coerce types.
    ajv: {
      customOptions: {
        removeAdditional: false,
        coerceTypes: false,
        useDefaults: false,
        allErrors: true,
      },
    },
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
  });
  // Only application/json bodies are accepted.
  app.removeContentTypeParser('text/plain');
  registerSecurityHeaders(app);
  registerErrorHandling(app, redactor);

  await app.register(cors, {
    origin: config.allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Request-Id', 'Last-Event-ID'],
    exposedHeaders: ['X-Request-Id', 'Location', 'ETag', 'Warning', 'X-Platform-Warnings'],
    maxAge: 600,
  });

  registerHealthRoutes(app, container);

  if (!container) {
    app.all('/api/v1/*', async () => {
      throw unavailable('The service is starting or a local dependency is unavailable.');
    });
    return app;
  }

  await app.register(
    async (api) => {
      registerApiGuards(api, config, container.auth);
      registerCatalogRoutes(api, container);
      registerAssetRoutes(api, container, { type: 'test', path: 'tests', deletable: true });
      registerValidationRoutes(api, container);
      registerAssetRoutes(api, container, {
        type: 'test-data',
        path: 'test-data',
        deletable: true,
      });
      // Suites are read/create/update/list only; deleting and running Suites is deferred.
      registerAssetRoutes(api, container, { type: 'suite', path: 'suites', deletable: false });
      registerAssetRoutes(api, container, {
        type: 'mock-setup',
        path: 'mock-setups',
        deletable: true,
      });
      registerRunRoutes(api, container);
      registerInspectorRoutes(api, container);
      registerConfigurationRoutes(api, container);
      registerSuiteRunRoutes(api, container);
      registerArtifactRoutes(api, container);
    },
    { prefix: '/api/v1' },
  );
  return app;
};
