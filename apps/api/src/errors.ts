import type { ErrorCode, ProblemDetails, ValidationIssue } from '@test-platform/contracts';
import { PlatformError, type Redactor } from '@test-platform/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_SCHEMA: 422,
  VALIDATION_FLOW: 422,
  VALIDATION_EXPRESSION: 422,
  VALIDATION_REFERENCE: 422,
  VALIDATION_TARGET_POLICY: 422,
  VALIDATION_CONFLICT: 409,
  VALIDATION_NOT_FOUND: 404,
  VALIDATION_SECRET_REFERENCE: 422,
  VALIDATION_INLINE_SECRET: 422,
  AUTH_CREDENTIAL: 401,
  AUTH_FORBIDDEN: 403,
  AUTH_SECRET_UNAVAILABLE: 502,
  TARGET_REQUEST: 502,
  TARGET_TIMEOUT: 504,
  TARGET_SERVICE: 502,
  EXECUTION_ASSERTION_FAILED: 500,
  EXECUTION_TRANSFORM_FAILED: 500,
  EXECUTION_TIMEOUT: 500,
  EXECUTION_CANCELLED: 409,
  EXECUTION_LEASE: 409,
  EXECUTION_INVALID_TRANSITION: 409,
  EXECUTION_NOT_PAUSED: 409,
  EXECUTION_STALE_CONTINUATION: 409,
  EXECUTION_BREAKPOINT_CONTEXT_CHANGED: 409,
  EXECUTION_ARTIFACT: 500,
  EXECUTION_SERIALIZATION: 500,
  SYSTEM_UNAVAILABLE: 503,
  SYSTEM_INTERNAL: 500,
};

const TITLE_BY_STATUS: Record<number, string> = {
  400: 'Bad request',
  401: 'Authentication required',
  403: 'Forbidden',
  404: 'Resource not found',
  409: 'Conflict',
  413: 'Payload too large',
  415: 'Unsupported media type',
  422: 'Validation failed',
  500: 'Internal server error',
  503: 'Service unavailable',
};

export const problemType = (code: ErrorCode): string =>
  `https://test-platform.dev/problems/${code.toLowerCase().replace(/_/g, '-')}`;

export const notFound = (what: string): PlatformError =>
  new PlatformError('VALIDATION_NOT_FOUND', `${what} was not found.`);

export const unavailable = (message: string): PlatformError =>
  new PlatformError('SYSTEM_UNAVAILABLE', message);

type NormalizedError = {
  status: number;
  code: ErrorCode;
  detail?: string;
  errors?: ValidationIssue[];
  log: boolean;
};

type FastifyLikeError = Error & {
  statusCode?: number;
  code?: string;
  validation?: {
    instancePath?: string;
    message?: string;
    keyword?: string;
    params?: { missingProperty?: string };
  }[];
};

const normalize = (error: unknown): NormalizedError => {
  if (error instanceof PlatformError) {
    const status = STATUS_BY_CODE[error.code];
    return {
      status,
      code: error.code,
      detail: error.code === 'SYSTEM_INTERNAL' ? undefined : error.message,
      errors: error.issues.length > 0 ? error.issues : undefined,
      log: status >= 500,
    };
  }

  const candidate = error as FastifyLikeError;
  if (candidate.validation) {
    return {
      status: 400,
      code: 'VALIDATION_SCHEMA',
      detail: 'The request does not match the expected shape.',
      errors: candidate.validation.map((issue) => ({
        path: issue.params?.missingProperty
          ? `${issue.instancePath ?? ''}/${issue.params.missingProperty}`
          : (issue.instancePath ?? ''),
        message: issue.message ?? 'is invalid',
        keyword: issue.keyword,
      })),
      log: false,
    };
  }

  const status = candidate.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    // Fastify's own client errors (malformed JSON, oversized bodies, unsupported media types).
    return {
      status,
      code: 'VALIDATION_SCHEMA',
      detail:
        status === 413
          ? 'The request body is too large.'
          : status === 415
            ? 'Only application/json is supported.'
            : 'The request could not be parsed.',
      log: false,
    };
  }
  return { status: 500, code: 'SYSTEM_INTERNAL', log: true };
};

export const toProblem = (
  error: unknown,
  request: Pick<FastifyRequest, 'id' | 'url'>,
  redactor: Redactor,
): { status: number; problem: ProblemDetails; log: boolean } => {
  const normalized = normalize(error);
  const path = request.url.split('?')[0] ?? '';
  const problem: ProblemDetails = {
    type: problemType(normalized.code),
    title: TITLE_BY_STATUS[normalized.status] ?? 'Request failed',
    status: normalized.status,
    code: normalized.code,
    instance: path,
    requestId: String(request.id),
  };
  if (normalized.detail) problem.detail = redactor.redactText(normalized.detail);
  if (normalized.errors) {
    problem.errors = normalized.errors.map((issue) => ({
      ...issue,
      message: redactor.redactText(issue.message),
    }));
  }
  return { status: normalized.status, problem, log: normalized.log };
};

export const sendProblem = (
  reply: FastifyReply,
  status: number,
  problem: ProblemDetails,
): FastifyReply => reply.status(status).type('application/problem+json').send(problem);

export const registerErrorHandling = (app: FastifyInstance, redactor: Redactor): void => {
  app.setErrorHandler((error, request, reply) => {
    const { status, problem, log } = toProblem(error, request, redactor);
    if (log) {
      const err = error as Error;
      // Stack traces stay in server logs and are masked for registered secrets.
      request.log.error(
        {
          code: problem.code,
          err: {
            message: redactor.redactText(err.message),
            stack: redactor.redactText(err.stack ?? ''),
          },
        },
        'Unhandled error',
      );
    }
    return sendProblem(reply, status, problem);
  });

  app.setNotFoundHandler((request, reply) => {
    const { status, problem } = toProblem(notFound('The requested endpoint'), request, redactor);
    return sendProblem(reply, status, problem);
  });
};
