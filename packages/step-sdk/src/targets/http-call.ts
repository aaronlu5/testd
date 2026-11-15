import type { ErrorInfo, JsonValue } from '@test-platform/contracts';
import {
  PlatformError,
  TARGET_LIMITS,
  assertRequestHeaders,
  type HttpRequestPlan,
  type HttpTransportResponse,
} from '@test-platform/core';
import { asTargetError, resolveSecret, utf8, type Context } from './support.js';

export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 30;

export type HttpCall = {
  target: string;
  method?: string;
  path: string;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  body?: JsonValue;
  requestTimeoutSeconds?: number;
};

export type HttpCallResult = {
  plan: HttpRequestPlan;
  response: HttpTransportResponse;
  durationMs: number;
};

const NO_BODY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const correlationHeaders = (context: Context): Record<string, string> => ({
  'x-correlation-id': context.correlation.runId,
  'x-test-platform-run-id': context.correlation.runId,
  'x-test-platform-step-run-id': context.correlation.stepRunId,
  'x-test-platform-node-id': context.correlation.nodeId,
  'x-test-platform-attempt': String(context.correlation.attempt),
});

const encodeBody = (
  body: JsonValue,
  headers: Record<string, string>,
): { bytes: Uint8Array; contentType: string } => {
  const userType = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type');
  if (typeof body === 'string')
    return { bytes: utf8(body), contentType: userType?.[1] ?? 'text/plain; charset=utf-8' };
  return { bytes: utf8(JSON.stringify(body)), contentType: userType?.[1] ?? 'application/json' };
};

/**
 * The one place an HTTP request is built: policy decides the URL, the target decides the
 * credential, and the platform decides correlation headers. Test-supplied headers cannot
 * override any of them.
 */
export const performHttpCall = async (
  context: Context,
  call: HttpCall,
): Promise<HttpCallResult> => {
  const method = (call.method ?? 'GET').toUpperCase();
  const plan = context.policy.http(call.target, {
    method,
    path: call.path,
    ...(call.query ? { query: call.query } : {}),
  });
  const userHeaders = call.headers ?? {};
  assertRequestHeaders(userHeaders);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(userHeaders)) headers[name.toLowerCase()] = value;

  let body: Uint8Array | undefined;
  if (call.body !== undefined) {
    if (NO_BODY_METHODS.has(plan.method))
      throw new PlatformError('VALIDATION_SCHEMA', `A ${plan.method} request cannot have a body.`);
    const encoded = encodeBody(call.body, headers);
    body = encoded.bytes;
    headers['content-type'] = encoded.contentType;
    const ceiling = Math.min(TARGET_LIMITS.httpRequestBytes, context.limits.transferBytes);
    if (body.byteLength > ceiling)
      throw new PlatformError(
        'VALIDATION_TARGET_POLICY',
        `The request body (${body.byteLength} bytes) exceeds the limit of ${ceiling} bytes.`,
      );
  }

  if (plan.correlationHeaders) Object.assign(headers, correlationHeaders(context));

  if (plan.authentication) {
    const secret = await resolveSecret(context, plan.authentication);
    if (secret.includes('\r') || secret.includes('\n') || secret.includes('\0'))
      throw new PlatformError(
        'AUTH_SECRET_UNAVAILABLE',
        `Secret "${plan.authentication.name}" cannot be used as an HTTP header value.`,
      );
    if (plan.authentication.usage === 'bearerToken') headers.authorization = `Bearer ${secret}`;
    else headers['ocp-apim-subscription-key'] = secret;
  }

  const timeoutMs = Math.round(
    (call.requestTimeoutSeconds ?? DEFAULT_REQUEST_TIMEOUT_SECONDS) * 1000,
  );
  const started = context.clock.now().getTime();
  try {
    const response = await context.clients.http.send({
      method: plan.method,
      url: plan.url,
      headers,
      ...(body ? { body } : {}),
      signal: context.signal,
      timeoutMs,
      maxResponseBytes: Math.min(TARGET_LIMITS.httpResponseBytes, context.limits.transferBytes),
    });
    return { plan, response, durationMs: Math.max(context.clock.now().getTime() - started, 0) };
  } catch (error) {
    throw asTargetError(error, `HTTP ${plan.method} ${plan.path}`);
  }
};

/** Error code for an unexpected HTTP status. */
export const errorForStatus = (
  status: number,
  path: string,
  method: string,
  expected: string,
): ErrorInfo => {
  let code: ErrorInfo['code'] = 'TARGET_REQUEST';
  if (status === 401) code = 'AUTH_CREDENTIAL';
  else if (status === 403) code = 'AUTH_FORBIDDEN';
  else if (status === 408 || status === 504) code = 'TARGET_TIMEOUT';
  else if (status === 429 || status >= 500) code = 'TARGET_SERVICE';
  return {
    code,
    message: `${method} ${path} returned HTTP ${status}; expected ${expected}.`,
  };
};

export const isExpectedStatus = (
  status: number,
  expected: readonly number[] | undefined,
): boolean =>
  expected && expected.length > 0 ? expected.includes(status) : status >= 200 && status < 300;

export const describeExpected = (expected: readonly number[] | undefined): string =>
  expected && expected.length > 0 ? expected.join(', ') : '2xx';

const decoder = new TextDecoder('utf-8', { fatal: false });
const TEXTUAL =
  /^(?:text\/|application\/(?:json|xml|x-www-form-urlencoded|problem\+json)|.*\+(?:json|xml))/i;

export const isTextual = (contentType: string | undefined): boolean =>
  contentType === undefined || contentType === '' || TEXTUAL.test(contentType);

export type CapturedBody = {
  body: JsonValue;
  bodyEncoding: 'json' | 'text' | 'base64' | 'empty';
  bodyTruncated: boolean;
};

/** Decodes a response body for the Step output, bounded by `inlineBytes`. */
export const captureBody = (response: HttpTransportResponse, inlineBytes: number): CapturedBody => {
  const bytes = response.body;
  if (bytes.byteLength === 0) return { body: null, bodyEncoding: 'empty', bodyTruncated: false };
  const contentType = response.headers['content-type'];
  const clipped = bytes.byteLength > inlineBytes;
  const slice = clipped ? bytes.subarray(0, inlineBytes) : bytes;
  if (!isTextual(contentType))
    return {
      body: Buffer.from(slice).toString('base64'),
      bodyEncoding: 'base64',
      bodyTruncated: clipped || response.truncated,
    };
  const text = decoder.decode(slice);
  if (!clipped && !response.truncated && /json/i.test(contentType ?? '')) {
    try {
      return { body: JSON.parse(text) as JsonValue, bodyEncoding: 'json', bodyTruncated: false };
    } catch {
      /* fall through: report it as text */
    }
  }
  return { body: text, bodyEncoding: 'text', bodyTruncated: clipped || response.truncated };
};
