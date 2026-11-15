import type { JsonObject, JsonValue } from '@test-platform/contracts';
import {
  PlatformError,
  assertConnectionStringMatches,
  isRetryableCode,
  type TargetPolicy,
} from '@test-platform/core';
import type { StepDefinition } from '../types.js';
import { planBlobDownload, type BlobDownloadConfig } from './blob.js';
import { captureBody, performHttpCall } from './http-call.js';
import { httpCallSchemaProperties, planHttpRequest } from './http-request.js';
import {
  describeCredential,
  resolveSecret,
  sleepFor,
  throwIfCancelled,
  withClient,
  type Context,
} from './support.js';

export const WAIT_FOR_CONDITION_STEP_TYPE = 'waitForCondition';

/** Hard ceilings that no Test parameter can raise. */
export const WAIT_LIMITS = {
  maxAttempts: 120,
  maxDurationSeconds: 3600,
  minIntervalSeconds: 0.5,
  maxIntervalSeconds: 300,
} as const;

export const BODY_OPERATORS = ['equals', 'notEquals', 'exists', 'notExists', 'contains'] as const;
type BodyOperator = (typeof BODY_OPERATORS)[number];

export type WaitForConditionConfig = {
  probe: 'http' | 'blobExists';
  target: string;
  /** http: GET or HEAD only. */
  method?: 'GET' | 'HEAD';
  path?: string;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  container?: string;
  blobName?: string;
  /** http only: satisfied when the status is one of these (default 200). */
  untilStatus?: number[];
  /** http only: and the JSON response body satisfies this check. */
  untilBody?: { path: string; operator: BodyOperator; expected?: JsonValue };
  intervalSeconds?: number;
  backoffMultiplier?: number;
  maxIntervalSeconds?: number;
  maxAttempts?: number;
  maxDurationSeconds?: number;
  requestTimeoutSeconds?: number;
};

type ProbeResult = { satisfied: boolean; summary: JsonObject };

/** Reads `a.b.0.c` from parsed JSON; undefined when any segment is missing. */
const readPath = (value: JsonValue | undefined, path: string): JsonValue | undefined => {
  let current: JsonValue | undefined = value;
  for (const segment of path.split('.').filter(Boolean)) {
    if (Array.isArray(current)) current = current[Number(segment)];
    else if (typeof current === 'object' && current !== null) {
      current = Object.hasOwn(current, segment) ? current[segment] : undefined;
    } else return undefined;
  }
  return current;
};

const same = (a: JsonValue | undefined, b: JsonValue | undefined): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

const bodySatisfied = (
  body: JsonValue | undefined,
  check: NonNullable<WaitForConditionConfig['untilBody']>,
): boolean => {
  const actual = readPath(body, check.path);
  switch (check.operator) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'notExists':
      return actual === undefined || actual === null;
    case 'equals':
      return same(actual, check.expected);
    case 'notEquals':
      return actual !== undefined && !same(actual, check.expected);
    case 'contains':
      if (typeof actual === 'string')
        return typeof check.expected === 'string' && actual.includes(check.expected);
      return Array.isArray(actual) && actual.some((item) => same(item, check.expected));
  }
};

export const planWaitForCondition = (
  config: WaitForConditionConfig,
  policy: TargetPolicy,
): void => {
  if (config.probe === 'http') {
    planHttpRequest(
      { target: config.target, method: config.method ?? 'GET', path: config.path ?? '' },
      policy,
    );
  } else {
    planBlobDownload(
      {
        target: config.target,
        container: config.container ?? '',
        blobName: config.blobName ?? '',
      } satisfies BlobDownloadConfig,
      policy,
    );
  }
};

const probeHttp = async (
  context: Context,
  config: WaitForConditionConfig,
): Promise<ProbeResult> => {
  const { response, durationMs } = await performHttpCall(context, {
    target: config.target,
    method: config.method ?? 'GET',
    path: config.path as string,
    ...(config.query ? { query: config.query } : {}),
    ...(config.headers ? { headers: config.headers } : {}),
    ...(config.requestTimeoutSeconds
      ? { requestTimeoutSeconds: config.requestTimeoutSeconds }
      : {}),
  });
  const statuses = config.untilStatus?.length ? config.untilStatus : [200];
  let satisfied = statuses.includes(response.status);
  if (satisfied && config.untilBody) {
    const captured = captureBody(response, Math.max(context.limits.payloadBytes, 256));
    satisfied = !captured.bodyTruncated && bodySatisfied(captured.body, config.untilBody);
  }
  return { satisfied, summary: { status: response.status, durationMs } };
};

const probeBlob = async (
  context: Context,
  config: WaitForConditionConfig,
): Promise<ProbeResult> => {
  const plan = planBlobDownload(
    {
      target: config.target,
      container: config.container as string,
      blobName: config.blobName as string,
    },
    context.policy,
  );
  const credential = plan.target.credential;
  const connectionString = credential ? await resolveSecret(context, credential) : undefined;
  if (connectionString)
    assertConnectionStringMatches('azureBlob', connectionString, plan.accountHost);
  const client = context.clients.openBlob({
    accountUrl: plan.target.accountUrl,
    ...(connectionString ? { connectionString } : {}),
  });
  return withClient(client, async (blob) => {
    const properties = await blob.getProperties({
      container: plan.container,
      blobName: plan.blobName,
      signal: context.signal,
    });
    return {
      satisfied: properties !== undefined,
      summary: { exists: properties !== undefined, sizeBytes: properties?.contentLength ?? null },
    };
  });
};

export const waitForConditionStep: StepDefinition<WaitForConditionConfig> = {
  type: WAIT_FOR_CONDITION_STEP_TYPE,
  displayName: 'Wait for condition',
  description:
    'Polls a safe read-only condition (an HTTP GET/HEAD on a configured target, or the existence of an allowed blob) until it holds. Polling is bounded by attempts and total duration and stops immediately on cancellation.',
  configSchema: {
    type: 'object',
    required: ['probe', 'target'],
    additionalProperties: false,
    properties: {
      probe: { enum: ['http', 'blobExists'] },
      target: httpCallSchemaProperties.target,
      method: { enum: ['GET', 'HEAD'] },
      path: httpCallSchemaProperties.path,
      query: httpCallSchemaProperties.query,
      headers: httpCallSchemaProperties.headers,
      container: { type: 'string', minLength: 3 },
      blobName: { type: 'string', minLength: 1, maxLength: 1024 },
      untilStatus: {
        type: 'array',
        items: { type: 'integer', minimum: 100, maximum: 599 },
        uniqueItems: true,
      },
      untilBody: {
        type: 'object',
        required: ['path', 'operator'],
        additionalProperties: false,
        properties: {
          path: {
            type: 'string',
            minLength: 1,
            description: 'Dotted path into the JSON body, e.g. "state" or "items.0.id".',
          },
          operator: { enum: [...BODY_OPERATORS] },
          expected: {},
        },
      },
      intervalSeconds: {
        type: 'number',
        minimum: WAIT_LIMITS.minIntervalSeconds,
        maximum: WAIT_LIMITS.maxIntervalSeconds,
      },
      backoffMultiplier: { type: 'number', minimum: 1, maximum: 3 },
      maxIntervalSeconds: {
        type: 'number',
        minimum: WAIT_LIMITS.minIntervalSeconds,
        maximum: WAIT_LIMITS.maxIntervalSeconds,
      },
      maxAttempts: { type: 'integer', minimum: 1, maximum: WAIT_LIMITS.maxAttempts },
      maxDurationSeconds: { type: 'number', minimum: 1, maximum: WAIT_LIMITS.maxDurationSeconds },
      requestTimeoutSeconds: { type: 'number', minimum: 1, maximum: 60 },
    },
  },
  sensitivePaths: ['headers.authorization', 'headers.cookie', 'headers.ocp-apim-subscription-key'],
  defaults: {
    probe: 'http',
    method: 'GET',
    intervalSeconds: 2,
    maxAttempts: 30,
    maxDurationSeconds: 60,
  },
  // Polling is its own retry loop; a worker-level retry would restart the whole wait.
  capabilities: { external: true, supportsRetry: false, supportsArtifacts: false },
  validate(config, context) {
    const issues = [];
    const need = (field: keyof WaitForConditionConfig, when: boolean) => {
      if (when && config[field] === undefined)
        issues.push({
          path: `/${field}`,
          message: `is required for probe "${config.probe}"`,
          keyword: 'required',
        });
    };
    need('path', config.probe === 'http');
    need('container', config.probe === 'blobExists');
    need('blobName', config.probe === 'blobExists');
    if (config.probe === 'blobExists' && (config.untilStatus || config.untilBody || config.path))
      issues.push({
        path: '/probe',
        message: 'HTTP options cannot be combined with probe "blobExists"',
        keyword: 'step-config',
      });
    if (
      config.untilBody &&
      config.untilBody.expected === undefined &&
      !['exists', 'notExists'].includes(config.untilBody.operator)
    )
      issues.push({
        path: '/untilBody/expected',
        message: 'is required for this operator',
        keyword: 'required',
      });
    if (context.targets) {
      try {
        context.targets.resolve(config.target, config.probe === 'http' ? 'http' : 'azureBlob');
      } catch (error) {
        issues.push({
          path: '/target',
          message: error instanceof PlatformError ? error.message : 'Unknown target.',
          keyword: 'target-policy',
        });
      }
    }
    return issues;
  },
  async execute(context, config) {
    planWaitForCondition(config, context.policy);
    const maxAttempts = Math.min(config.maxAttempts ?? 30, WAIT_LIMITS.maxAttempts);
    const maxDurationMs =
      Math.min(config.maxDurationSeconds ?? 60, WAIT_LIMITS.maxDurationSeconds) * 1000;
    const multiplier = config.backoffMultiplier ?? 1;
    const intervalCapMs = (config.maxIntervalSeconds ?? WAIT_LIMITS.maxIntervalSeconds) * 1000;
    let intervalMs = Math.max(
      (config.intervalSeconds ?? 2) * 1000,
      WAIT_LIMITS.minIntervalSeconds * 1000,
    );
    context.logger.info(
      `Polling ${config.probe} up to ${maxAttempts} times or ${maxDurationMs / 1000}s`,
    );
    if (config.probe === 'http' && context.policy) {
      const plan = context.policy.http(config.target, {
        method: config.method ?? 'GET',
        path: config.path as string,
      });
      if (plan.authentication)
        context.logger.info(`Using ${describeCredential(plan.authentication)}`);
    }

    const started = context.clock.now().getTime();
    let last: JsonObject = {};
    let lastError: string | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      throwIfCancelled(context);
      try {
        const result = await (config.probe === 'http'
          ? probeHttp(context, config)
          : probeBlob(context, config));
        last = result.summary;
        lastError = undefined;
        if (result.satisfied) {
          const elapsedMs = context.clock.now().getTime() - started;
          context.logger.info(`Condition met on poll ${attempt}`, { elapsedMs });
          return {
            status: 'Succeeded',
            output: { satisfied: true, polls: attempt, elapsedMs, last } as JsonObject,
            logs: context.logger.entries(),
          };
        }
      } catch (error) {
        if (!(error instanceof PlatformError)) throw error;
        // Only transient target trouble is worth another poll; policy, credential and
        // cancellation problems end the wait now.
        if (!isRetryableCode(error.code)) throw error;
        lastError = error.code;
        last = { error: error.code };
      }

      const elapsed = context.clock.now().getTime() - started;
      if (attempt === maxAttempts || elapsed + intervalMs > maxDurationMs) break;
      await sleepFor(context, intervalMs);
      intervalMs = Math.min(Math.round(intervalMs * multiplier), intervalCapMs);
    }

    const elapsedMs = context.clock.now().getTime() - started;
    return {
      status: 'Failed',
      output: {
        satisfied: false,
        elapsedMs,
        last,
        ...(lastError ? { lastError } : {}),
      } as JsonObject,
      logs: context.logger.entries(),
      error: {
        code: 'EXECUTION_ASSERTION_FAILED',
        message: 'The condition was not met before the polling limits were reached.',
        detail: `elapsedMs=${elapsedMs}; maxAttempts=${maxAttempts}; maxDurationSeconds=${maxDurationMs / 1000}`,
      },
    };
  },
};
