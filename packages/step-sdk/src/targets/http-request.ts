import { STATUS_CODES } from 'node:http';
import type { JsonObject, JsonValue } from '@test-platform/contracts';
import {
  assertRequestHeaders,
  HTTP_METHODS,
  PlatformError,
  SAFE_HTTP_METHODS,
  type HttpTransportResponse,
  type TargetPolicy,
} from '@test-platform/core';
import type { StepDefinition } from '../types.js';
import {
  captureBody,
  describeExpected,
  errorForStatus,
  isExpectedStatus,
  isTextual,
  performHttpCall,
  type HttpCall,
  type HttpCallResult,
} from './http-call.js';
import { gateRetry } from './support.js';

export const HTTP_REQUEST_STEP_TYPE = 'http.request';

export type HttpRequestConfig = HttpCall & {
  expectedStatus?: number[];
  /** The request may be repeated after a timeout or 429/5xx without side effects or duplicates. */
  retrySafe?: boolean;
  /** Return `mockStatus` and `mockBody` instead of calling the target. */
  mock?: boolean;
  mockStatus?: number;
  mockBody?: JsonValue;
};

export const httpCallSchemaProperties = {
  target: {
    type: 'string',
    minLength: 1,
    description: 'Logical HTTP target from the Environment.',
  },
  path: {
    type: 'string',
    pattern: '^/',
    description: 'Path relative to the target base URL, without query or fragment.',
  },
  query: {
    type: 'object',
    additionalProperties: { type: ['string', 'number', 'boolean'] },
  },
  headers: { type: 'object', additionalProperties: { type: 'string' } },
  requestTimeoutSeconds: { type: 'number', minimum: 1, maximum: 300 },
} as const;

/** Policy checks that need no I/O; also used to validate literal Test parameters before a Run. */
export const planHttpRequest = (config: HttpRequestConfig, policy: TargetPolicy): void => {
  if (config.headers) assertRequestHeaders(config.headers);
  policy.http(config.target, {
    method: config.method ?? 'GET',
    path: config.path,
    ...(config.query ? { query: config.query } : {}),
  });
};

const textEncoder = new TextEncoder();

/**
 * The response a mocked request returns. The request is still checked against the target policy
 * (so the Test cannot mock something the real call would be refused), but nothing is sent and no
 * credential is read.
 */
const mockedCall = (
  context: Parameters<typeof performHttpCall>[0],
  config: HttpRequestConfig,
): HttpCallResult => {
  const plan = context.policy.http(config.target, {
    method: (config.method ?? 'GET').toUpperCase(),
    path: config.path,
    ...(config.query ? { query: config.query } : {}),
  });
  if (config.headers) assertRequestHeaders(config.headers);
  const status = config.mockStatus ?? 200;
  const body =
    config.mockBody === undefined
      ? new Uint8Array()
      : textEncoder.encode(JSON.stringify(config.mockBody));
  const response: HttpTransportResponse = {
    status,
    statusText: STATUS_CODES[status] ?? '',
    headers: body.byteLength > 0 ? { 'content-type': 'application/json' } : {},
    body,
    truncated: false,
  };
  return { plan, response, durationMs: 0 };
};

export const httpRequestStep: StepDefinition<HttpRequestConfig> = {
  type: HTTP_REQUEST_STEP_TYPE,
  displayName: 'HTTP request',
  description:
    'Calls an HTTP or API Management endpoint on a configured target. Only relative paths allowed by the Environment can be called; credentials come from the target and never from the Test. Requests are retried only when "retrySafe" is true. Tick Mock to return a given status and JSON body without calling the target.',
  configSchema: {
    type: 'object',
    required: ['target', 'path'],
    additionalProperties: false,
    properties: {
      ...httpCallSchemaProperties,
      method: { enum: [...HTTP_METHODS] },
      body: {
        description:
          'JSON value or string sent as the request body (not allowed for GET, HEAD or OPTIONS).',
      },
      mock: {
        type: 'boolean',
        description:
          'Return the mock status and body below instead of calling the target. Nothing is sent and no credential is used.',
      },
      mockStatus: {
        type: 'integer',
        minimum: 100,
        maximum: 599,
        description: 'Status code returned when mocking. Defaults to 200.',
      },
      mockBody: { description: 'JSON value returned as the response body when mocking.' },
      expectedStatus: {
        type: 'array',
        items: { type: 'integer', minimum: 100, maximum: 599 },
        uniqueItems: true,
        description: 'Accepted status codes. Defaults to any 2xx.',
      },
      retrySafe: {
        type: 'boolean',
        description:
          'Declare that repeating this request is safe. When false (default) a transient failure is reported but never retried.',
      },
    },
  },
  sensitivePaths: [
    'headers.authorization',
    'headers.proxy-authorization',
    'headers.cookie',
    'headers.ocp-apim-subscription-key',
    'headers.set-cookie',
  ],
  defaults: { method: 'GET', retrySafe: false, mock: false },
  capabilities: { external: true, supportsRetry: true, supportsArtifacts: true },
  validate(config, context) {
    const issues = [];
    if (context.targets) {
      try {
        context.targets.resolve(config.target, 'http');
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
    const method = (config.method ?? 'GET').toUpperCase();
    const retrySafe = config.retrySafe === true;
    if (retrySafe && !SAFE_HTTP_METHODS.has(method) && method !== 'PUT') {
      context.logger.warn(
        `${method} was declared retry-safe; make sure the endpoint is idempotent (for example by an idempotency key).`,
      );
    }
    const why = 'the request was not declared retry-safe ("retrySafe": true).';

    let result;
    try {
      if (config.mock === true) {
        context.logger.info(
          'Mock enabled: returning the mocked response without calling the target',
        );
        result = mockedCall(context, config);
      } else {
        result = await performHttpCall(context, config);
      }
    } catch (error) {
      throw error instanceof PlatformError ? gateRetry(error, retrySafe, why) : error;
    }
    const { plan, response, durationMs } = result;
    context.logger.info(`${plan.method} ${plan.path} -> ${response.status}`, { durationMs });

    const inlineBytes = Math.max(Math.floor(context.limits.payloadBytes / 2), 256);
    const captured = captureBody(response, inlineBytes);
    const output: JsonObject = {
      target: config.target,
      method: plan.method,
      path: plan.path,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: captured.body,
      bodyEncoding: captured.bodyEncoding,
      bodyTruncated: captured.bodyTruncated,
      bodyBytes: response.body.byteLength,
      durationMs,
      ...(config.mock === true ? { mocked: true } : {}),
    };

    const artifacts = [];
    if (captured.bodyTruncated && response.body.byteLength > 0) {
      const contentType = response.headers['content-type'] ?? 'application/octet-stream';
      try {
        // Text goes through the artifact writer as a string so secret masking applies.
        artifacts.push(
          await context.artifacts.write({
            content: isTextual(contentType)
              ? new TextDecoder().decode(response.body)
              : response.body,
            contentType,
            label: 'http-response-body',
          }),
        );
        output.bodyArtifact = artifacts[0]?.id ?? null;
      } catch {
        context.logger.warn('The full response body could not be stored as an artifact.');
      }
    }

    if (!isExpectedStatus(response.status, config.expectedStatus)) {
      const error = errorForStatus(
        response.status,
        plan.path,
        plan.method,
        describeExpected(config.expectedStatus),
      );
      const gated = gateRetry(new PlatformError(error.code, error.message), retrySafe, why);
      return {
        status: 'Failed',
        output: output as JsonValue,
        logs: context.logger.entries(),
        artifacts,
        error: {
          code: gated.code,
          message: gated.message,
          ...(gated.detail ? { detail: gated.detail } : {}),
        },
      };
    }
    return {
      status: 'Succeeded',
      output: output as JsonValue,
      logs: context.logger.entries(),
      artifacts,
    };
  },
};
