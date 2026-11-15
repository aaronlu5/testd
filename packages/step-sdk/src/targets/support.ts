import type { SecretReference } from '@test-platform/contracts';
import {
  PlatformError,
  cancellableSleep,
  isRetryableCode,
  mapTargetFailure,
} from '@test-platform/core';
import type { StepExecutionContext } from '../types.js';

export type Context = StepExecutionContext;

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * Retry gate for Steps whose operation is not naturally idempotent. The worker retries on
 * retryable codes alone, so a transient failure that must not be repeated is reported with a
 * non-retryable code and an explanation, keeping the original classification in `detail`.
 */
export const gateRetry = (
  error: PlatformError,
  allowRetry: boolean,
  why: string,
): PlatformError => {
  if (allowRetry || !isRetryableCode(error.code)) return error;
  return new PlatformError('TARGET_REQUEST', `${error.message} It will not be retried: ${why}`, {
    detail: [error.detail, `originalCode=${error.code}`].filter(Boolean).join('; '),
    ...(error.correlationIds ? { correlationIds: error.correlationIds } : {}),
  });
};

/** Converts anything thrown by a client into a PlatformError with fixed, secret-free text. */
export const asTargetError = (error: unknown, action: string): PlatformError =>
  mapTargetFailure(error, action);

/** Resolves a target credential just before use; the value is returned to the caller only. */
export const resolveSecret = async (
  context: Context,
  reference: SecretReference,
): Promise<string> => {
  const value = await context.secretReferences.resolve(reference);
  if (value.length === 0)
    throw new PlatformError(
      'AUTH_SECRET_UNAVAILABLE',
      `Secret "${reference.name}" in provider "${reference.provider}" is empty.`,
    );
  return value;
};

export const describeCredential = (reference: SecretReference | undefined): string =>
  reference
    ? `secret reference "${reference.name}" (${reference.provider})`
    : 'Entra credentials (DefaultAzureCredential)';

/** Runs `use` with a client and always closes it; close failures never mask the real outcome. */
export const withClient = async <T extends { close(): Promise<void> }, R>(
  client: T,
  use: (client: T) => Promise<R>,
): Promise<R> => {
  try {
    return await use(client);
  } finally {
    await client.close().catch(() => undefined);
  }
};

export const sleepFor = (context: Context, ms: number): Promise<void> =>
  context.sleep ? context.sleep(ms, context.signal) : cancellableSleep(ms, context.signal);

export const throwIfCancelled = (context: Context): void => {
  if (context.signal.aborted)
    throw new PlatformError('EXECUTION_CANCELLED', 'The Step was cancelled.');
};
