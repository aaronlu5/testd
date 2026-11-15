import { PlatformError } from './errors.js';

type FailureLike = {
  name?: unknown;
  code?: unknown;
  statusCode?: unknown;
  status?: unknown;
  response?: { headers?: { get?: (name: string) => string | null | undefined } };
};

const SAFE_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;

const NETWORK_TIMEOUT = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']);
const NETWORK_FAILURE = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_SOCKET',
]);
const CREDENTIAL_ERRORS = new Set([
  'AuthenticationError',
  'AuthenticationRequiredError',
  'CredentialUnavailableError',
  'AggregateAuthenticationError',
]);
const SERVICE_BUS_SERVICE = new Set([
  'ServiceBusError',
  'ServiceUnavailableError',
  'ServerBusyError',
  'InternalServerError',
  'ServiceCommunicationError',
  'SessionLockLostError',
]);
const SERVICE_BUS_TIMEOUT = new Set(['ServiceTimeout', 'OperationTimeoutError']);
const SERVICE_BUS_DENIED = new Set(['UnauthorizedError', 'MessagingEntityDisabledError']);

const token = (value: unknown): string | undefined =>
  typeof value === 'string' && SAFE_TOKEN.test(value) ? value : undefined;

const statusOf = (failure: FailureLike): number | undefined => {
  const value = failure.statusCode ?? failure.status;
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
};

const fromStatus = (status: number): PlatformError['code'] => {
  if (status === 401) return 'AUTH_CREDENTIAL';
  if (status === 403) return 'AUTH_FORBIDDEN';
  if (status === 408 || status === 504) return 'TARGET_TIMEOUT';
  if (status === 429 || status >= 500) return 'TARGET_SERVICE';
  return 'TARGET_REQUEST';
};

const MESSAGES: Record<string, string> = {
  AUTH_CREDENTIAL: 'could not authenticate to the target',
  AUTH_FORBIDDEN: 'the identity is not permitted to perform this operation',
  TARGET_TIMEOUT: 'the target did not respond in time',
  TARGET_SERVICE: 'the target service is unavailable or throttling',
  TARGET_REQUEST: 'the target rejected the request',
};

/**
 * Maps anything an Azure SDK or HTTP client throws to a PlatformError whose text is fixed by
 * this function. The original message is never copied: SDK messages can quote request URLs,
 * headers or connection strings. Only the numeric status and a token-shaped error code survive,
 * as `detail`.
 */
export const mapTargetFailure = (error: unknown, action: string): PlatformError => {
  if (error instanceof PlatformError) return error;
  const failure: FailureLike = typeof error === 'object' && error !== null ? error : {};
  const name = typeof failure.name === 'string' ? failure.name : undefined;

  if (name === 'AbortError')
    return new PlatformError('EXECUTION_CANCELLED', `${action} was cancelled.`);

  const status = statusOf(failure);
  const code = token(failure.code);
  let mapped: PlatformError['code'] = 'TARGET_REQUEST';
  if (name && CREDENTIAL_ERRORS.has(name)) mapped = 'AUTH_CREDENTIAL';
  else if (status !== undefined) mapped = fromStatus(status);
  else if (code && NETWORK_TIMEOUT.has(code)) mapped = 'TARGET_TIMEOUT';
  else if (code && NETWORK_FAILURE.has(code)) mapped = 'TARGET_SERVICE';
  else if (code && SERVICE_BUS_TIMEOUT.has(code)) mapped = 'TARGET_TIMEOUT';
  else if (code && SERVICE_BUS_SERVICE.has(code)) mapped = 'TARGET_SERVICE';
  else if (code && SERVICE_BUS_DENIED.has(code)) mapped = 'AUTH_FORBIDDEN';
  else if (name === 'TimeoutError') mapped = 'TARGET_TIMEOUT';

  const detail = [
    status !== undefined ? `status=${status}` : undefined,
    code ? `code=${code}` : undefined,
  ]
    .filter(Boolean)
    .join('; ');
  const requestId = token(failure.response?.headers?.get?.('x-ms-request-id'));
  return new PlatformError(
    mapped,
    `${action} failed: ${MESSAGES[mapped] ?? MESSAGES.TARGET_REQUEST}.`,
    {
      ...(detail ? { detail } : {}),
      ...(requestId ? { correlationIds: { azureRequestId: requestId } } : {}),
    },
  );
};
