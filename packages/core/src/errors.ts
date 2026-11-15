import type { ErrorCode, ErrorFamily, ErrorInfo, ValidationIssue } from '@test-platform/contracts';

const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'TARGET_TIMEOUT',
  'TARGET_SERVICE',
  'EXECUTION_TIMEOUT',
]);

export const isRetryableCode = (code: ErrorCode): boolean => RETRYABLE_CODES.has(code);

export const errorFamily = (code: ErrorCode): ErrorFamily =>
  code.slice(0, code.indexOf('_')) as ErrorFamily;

export type PlatformErrorOptions = {
  /** Sanitized technical detail; must not contain secrets. */
  detail?: string;
  retryable?: boolean;
  issues?: ValidationIssue[];
  correlationIds?: Record<string, string>;
  cause?: unknown;
};

export class PlatformError extends Error {
  readonly code: ErrorCode;
  readonly detail?: string;
  readonly retryable: boolean;
  readonly issues: ValidationIssue[];
  readonly correlationIds?: Record<string, string>;

  constructor(code: ErrorCode, message: string, options: PlatformErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PlatformError';
    this.code = code;
    this.detail = options.detail;
    this.retryable = options.retryable ?? RETRYABLE_CODES.has(code);
    this.issues = options.issues ?? [];
    this.correlationIds = options.correlationIds;
  }

  get family(): ErrorFamily {
    return errorFamily(this.code);
  }
}

export const isPlatformError = (value: unknown): value is PlatformError =>
  value instanceof PlatformError;

/** Maps any thrown value to a persistable record without leaking messages from unknown errors. */
export const toErrorInfo = (error: unknown): ErrorInfo => {
  if (isPlatformError(error)) {
    const info: ErrorInfo = { code: error.code, message: error.message };
    if (error.detail) info.detail = error.detail;
    if (error.correlationIds) info.correlationIds = error.correlationIds;
    return info;
  }
  return { code: 'SYSTEM_INTERNAL', message: 'An unexpected internal error occurred.' };
};

/** Error for a command applied to a Run that is not paused, or to a stale pause. */
export const notPausedError = (): PlatformError =>
  new PlatformError('EXECUTION_NOT_PAUSED', 'The Run is not paused.');
export const staleContinuationError = (): PlatformError =>
  new PlatformError(
    'EXECUTION_STALE_CONTINUATION',
    'The Run was resumed or changed since this pause was inspected.',
  );
