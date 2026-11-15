export const ERROR_FAMILIES = ['VALIDATION', 'AUTH', 'TARGET', 'EXECUTION', 'SYSTEM'] as const;
export type ErrorFamily = (typeof ERROR_FAMILIES)[number];

export const ERROR_CODES = [
  'VALIDATION_SCHEMA',
  'VALIDATION_FLOW',
  'VALIDATION_EXPRESSION',
  'VALIDATION_REFERENCE',
  'VALIDATION_TARGET_POLICY',
  'VALIDATION_CONFLICT',
  'VALIDATION_NOT_FOUND',
  'VALIDATION_SECRET_REFERENCE',
  'VALIDATION_INLINE_SECRET',
  'AUTH_CREDENTIAL',
  'AUTH_FORBIDDEN',
  'AUTH_SECRET_UNAVAILABLE',
  'TARGET_REQUEST',
  'TARGET_TIMEOUT',
  'TARGET_SERVICE',
  'EXECUTION_ASSERTION_FAILED',
  'EXECUTION_TRANSFORM_FAILED',
  'EXECUTION_TIMEOUT',
  'EXECUTION_CANCELLED',
  'EXECUTION_LEASE',
  'EXECUTION_INVALID_TRANSITION',
  'EXECUTION_NOT_PAUSED',
  'EXECUTION_STALE_CONTINUATION',
  'EXECUTION_BREAKPOINT_CONTEXT_CHANGED',
  'EXECUTION_ARTIFACT',
  'EXECUTION_SERIALIZATION',
  'SYSTEM_UNAVAILABLE',
  'SYSTEM_INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type ValidationIssue = {
  /** JSON pointer or dotted path to the offending value. */
  path: string;
  message: string;
  keyword?: string;
};

/** RFC 7807 problem details with platform extensions. */
export type ProblemDetails = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: ErrorCode;
  requestId?: string;
  errors?: ValidationIssue[];
};

/** Sanitized error record persisted on Runs and Step Runs. */
export type ErrorInfo = {
  code: ErrorCode;
  message: string;
  /** Sanitized technical detail; never contains secrets or stack traces. */
  detail?: string;
  /** Correlation identifiers from Azure/HTTP responses. */
  correlationIds?: Record<string, string>;
};
