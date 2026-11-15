import { PlatformError } from '@test-platform/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { isLoopbackHost, type ApiConfig } from './config.js';

export type Identity = {
  /** Stable actor id recorded in audit events and `requestedBy`. */
  id: string;
  displayName: string;
  method: 'local-dev';
};

/** Authentication stays behind this seam so Entra (or another IdP) can replace the local-dev provider. */
export interface AuthProvider {
  authenticate(request: FastifyRequest): Promise<Identity>;
}

declare module 'fastify' {
  interface FastifyRequest {
    identity?: Identity;
  }
}

/**
 * Local-development identity: every caller on the loopback interface is the configured dev user.
 * This is NOT production authentication; the API refuses to bind to a non-loopback address.
 */
export const createLocalDevAuth = (devUser: string): AuthProvider => ({
  authenticate: async () => ({ id: devUser, displayName: devUser, method: 'local-dev' }),
});

export const identityOf = (request: FastifyRequest): Identity => {
  if (!request.identity) throw new PlatformError('AUTH_CREDENTIAL', 'Authentication is required.');
  return request.identity;
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const hostnameOf = (hostHeader: string | undefined): string | undefined => {
  if (!hostHeader) return undefined;
  const match = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(hostHeader.trim());
  return match?.[1];
};

/**
 * Guards the `/api/v1` scope: loopback `Host` only (DNS-rebinding defence), same-site `Origin`
 * on state-changing requests (CSRF defence), then authentication.
 */
export const registerApiGuards = (
  scope: FastifyInstance,
  config: Pick<ApiConfig, 'allowedOrigins'>,
  auth: AuthProvider,
): void => {
  scope.addHook('onRequest', async (request) => {
    if (request.method === 'OPTIONS') return;

    const hostname = hostnameOf(request.headers.host);
    if (!hostname || !isLoopbackHost(hostname)) {
      throw new PlatformError('AUTH_FORBIDDEN', 'This Host header is not permitted.');
    }

    const origin = request.headers.origin;
    if (
      !SAFE_METHODS.has(request.method) &&
      origin !== undefined &&
      !config.allowedOrigins.includes(origin)
    ) {
      throw new PlatformError('AUTH_FORBIDDEN', 'This Origin is not permitted.');
    }

    request.identity = await auth.authenticate(request);
  });
};

/** Defence-in-depth response headers; API responses are never cacheable. */
export const registerSecurityHeaders = (app: FastifyInstance): void => {
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
  });
};
