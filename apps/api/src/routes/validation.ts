import {
  ASSET_SCHEMA_VERSION,
  LEGACY_EDITOR_SETTINGS,
  TEST_SCHEMA_VERSION,
} from '@test-platform/contracts';
import { PlatformError } from '@test-platform/core';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../container.js';
import { normalizeCandidate } from '../services/layout.js';
import { idParam } from './assets.js';

type ValidateBody = { environmentId?: string; test?: Record<string, unknown> };

const ENVIRONMENT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The body is optional, so it is checked here rather than with a route schema. */
const parseBody = (body: unknown): ValidateBody => {
  if (body === undefined || body === null) return {};
  const fail = (path: string, message: string): never => {
    throw new PlatformError('VALIDATION_SCHEMA', 'The request body is not valid.', {
      issues: [{ path, message }],
    });
  };
  if (typeof body !== 'object' || Array.isArray(body)) return fail('', 'must be a JSON object');

  const { environmentId, test, ...rest } = body as Record<string, unknown>;
  for (const key of Object.keys(rest)) fail(`/${key}`, 'is not a known property');
  if (
    environmentId !== undefined &&
    !(typeof environmentId === 'string' && ENVIRONMENT_ID.test(environmentId))
  ) {
    fail('/environmentId', 'must be an environment id');
  }
  if (test !== undefined && (typeof test !== 'object' || test === null || Array.isArray(test))) {
    fail('/test', 'must be an object');
  }
  return {
    environmentId: environmentId as string | undefined,
    test: test as Record<string, unknown> | undefined,
  };
};

export const registerValidationRoutes = (api: FastifyInstance, container: Container): void => {
  /**
   * Validates the stored Test, or a draft sent in `test`, against the schema, flow rules,
   * expressions, Step configurations, and (with `environmentId`) the Environment's target policy.
   * Nothing is saved or run. Server-owned fields in a draft are replaced by the stored values.
   */
  api.post<{ Params: { id: string }; Body: unknown }>(
    '/tests/:id/validate',
    { schema: { params: idParam } },
    async (request) => {
      const body = parseBody(request.body);
      const stored = await container.definitions.get('test', request.params.id);
      const environment = body.environmentId
        ? await container.environments.require(body.environmentId)
        : undefined;

      const draft = body.test;
      let candidate: Record<string, unknown>;
      if (draft) {
        // A draft that omits `editor` keeps the stored layout settings, as an update would.
        const editor =
          'editor' in draft ? draft.editor : (stored.asset as { editor?: unknown }).editor;
        candidate = {
          tags: [],
          variables: {},
          ...draft,
          schemaVersion:
            typeof draft.schemaVersion === 'number'
              ? draft.schemaVersion
              : editor !== undefined
                ? TEST_SCHEMA_VERSION
                : ASSET_SCHEMA_VERSION,
          id: stored.asset.id,
          version: stored.asset.version,
          metadata: stored.asset.metadata,
        };
        if (editor !== undefined) candidate.editor = editor;
      } else {
        candidate = stored.asset as unknown as Record<string, unknown>;
      }

      // Position-managed Tests are re-sequenced on the server before they are judged.
      const normalized = normalizeCandidate(candidate);
      const report = container.validation.validateTest(normalized.candidate, environment);
      const result = normalized.candidate as { edges?: unknown; editor?: unknown };
      return {
        ...report,
        warnings: normalized.warnings,
        ...(normalized.normalization ? { normalization: normalized.normalization } : {}),
        normalized: {
          editor: result.editor ?? { ...LEGACY_EDITOR_SETTINGS },
          edges: result.edges ?? [],
        },
      };
    },
  );
};
