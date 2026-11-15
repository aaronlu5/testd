import {
  upgradeTestToCurrentSchema,
  type AssetType,
  type TestDefinition,
} from '@test-platform/contracts';
import { SAFE_ID } from '@test-platform/infrastructure-local';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../container.js';
import { PlatformError } from '@test-platform/core';
import { identityOf } from '../security.js';
import type { ApiWarning } from '../services/layout.js';

export const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: SAFE_ID.source } },
} as const;

/** Query strings arrive as text; accept only plain non-negative integers. */
export const parseIntQuery = (
  value: string | undefined,
  name: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || parsed < min || parsed > max) {
    throw new PlatformError(
      'VALIDATION_SCHEMA',
      `Query parameter "${name}" must be an integer between ${min} and ${max}.`,
    );
  }
  return parsed;
};

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tag: { type: 'string', minLength: 1, maxLength: 64 },
    search: { type: 'string', minLength: 1, maxLength: 100 },
  },
} as const;

const versionQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { version: { type: 'string', pattern: '^[0-9]+$' } },
} as const;

/**
 * Surfaces normalization on save without changing the asset body clients PUT back: a standard
 * `Warning` header plus a machine-readable `X-Platform-Warnings` list of codes.
 */
export const setWarnings = (
  reply: { header: (name: string, value: string) => unknown },
  warnings: readonly ApiWarning[] | undefined,
): void => {
  if (!warnings || warnings.length === 0) return;
  reply.header('X-Platform-Warnings', warnings.map((warning) => warning.code).join(','));
  reply.header('Warning', `199 test-platform "${warnings.map((w) => w.message).join(' ')}"`);
};

/**
 * Legacy Tests are presented in the current schema (editor settings, sequencing off); the stored
 * file is unchanged until the Test is next saved.
 */
const present = <T>(type: AssetType, asset: T): T =>
  type === 'test' ? (upgradeTestToCurrentSchema(asset as TestDefinition) as T) : asset;

export type AssetRouteOptions = { type: AssetType; path: string; deletable: boolean };

/** REST endpoints shared by Tests, Test Data, and Suites; behaviour lives in `DefinitionService`. */
export const registerAssetRoutes = (
  api: FastifyInstance,
  container: Container,
  options: AssetRouteOptions,
): void => {
  const { type, path } = options;
  const service = container.definitions;
  const location = (id: string): string => `/api/v1/${path}/${id}`;

  api.get<{ Querystring: { tag?: string; search?: string } }>(
    `/${path}`,
    { schema: { querystring: listQuery } },
    async (request) => ({
      items: await service.list(type, request.query),
    }),
  );

  api.post(`/${path}`, async (request, reply) => {
    const stored = await service.create(type, request.body, identityOf(request).id);
    reply.header('ETag', `"${stored.contentHash}"`).header('Location', location(stored.asset.id));
    setWarnings(reply, stored.warnings);
    return reply.status(201).send(present(type, stored.asset));
  });

  api.get<{ Params: { id: string }; Querystring: { version?: string } }>(
    `/${path}/:id`,
    { schema: { params: idParam, querystring: versionQuery } },
    async (request, reply) => {
      const stored = await service.get(
        type,
        request.params.id,
        parseIntQuery(request.query.version, 'version', 1),
      );
      reply.header('ETag', `"${stored.contentHash}"`);
      return present(type, stored.asset);
    },
  );

  api.get<{ Params: { id: string } }>(
    `/${path}/:id/versions`,
    { schema: { params: idParam } },
    async (request) => ({
      items: await service.versions(type, request.params.id),
    }),
  );

  api.put<{ Params: { id: string } }>(
    `/${path}/:id`,
    { schema: { params: idParam } },
    async (request, reply) => {
      const stored = await service.update(
        type,
        request.params.id,
        request.body,
        identityOf(request).id,
      );
      reply.header('ETag', `"${stored.contentHash}"`);
      setWarnings(reply, stored.warnings);
      return present(type, stored.asset);
    },
  );

  if (options.deletable) {
    api.delete<{ Params: { id: string } }>(
      `/${path}/:id`,
      { schema: { params: idParam } },
      async (request, reply) => {
        await service.remove(
          type as Exclude<AssetType, 'suite'>,
          request.params.id,
          identityOf(request).id,
        );
        return reply.status(204).send();
      },
    );
  }
};
