import type { ErrorInfo, JsonValue, StepLogEntry, ValidationIssue } from '@test-platform/contracts';
import { PlatformError, createRedactor, toErrorInfo, type Redactor } from '@test-platform/core';
import { createStepLogger } from './logger.js';
import { validateStepConfig } from './registry.js';
import type {
  StepDefinition,
  StepExecutionContext,
  StepResult,
  ValidationContext,
} from './types.js';

export type ExecuteStepOptions = {
  timeoutMs: number;
  /** Supplies registered secret values and extra sensitive paths; defaults to path-based masking only. */
  redactor?: Redactor;
  validation?: ValidationContext;
};

export type StepOutcome = {
  /** Output, logs, and error are already masked and safe to persist. */
  result: StepResult;
  /** Resolved configuration with sensitive values masked. */
  maskedInput: JsonValue;
  durationMs: number;
};

const defaultRedactor = createRedactor({ secretValues: () => [] });

const describeIssues = (issues: ValidationIssue[]): string =>
  issues.map((issue) => `${issue.path || '/'} ${issue.message}`).join('; ');

/**
 * Validates the resolved config, runs the Step under a timeout and the caller's cancellation
 * signal, and masks everything that will be persisted.
 * Cancellation rejects with EXECUTION_CANCELLED; every other failure is reported in the result.
 */
export const executeStep = async (
  definition: StepDefinition<unknown>,
  config: JsonValue,
  context: Omit<StepExecutionContext, 'logger'>,
  options: ExecuteStepOptions,
): Promise<StepOutcome> => {
  const redactor = options.redactor ?? defaultRedactor;
  const paths = definition.sensitivePaths ?? [];
  const started = context.clock.now().getTime();
  const logger = createStepLogger(context.clock);
  const maskedInput = redactor.redact(config, paths) as JsonValue;

  const finish = (
    partial: Pick<StepResult, 'status'> & {
      output?: JsonValue;
      error?: ErrorInfo;
      artifacts?: StepResult['artifacts'];
    },
  ): StepOutcome => {
    const logs = logger.entries().map((entry): StepLogEntry => ({
      ...entry,
      message: redactor.redactText(entry.message),
      ...(entry.data !== undefined
        ? { data: redactor.redact(entry.data, paths) as JsonValue }
        : {}),
    }));
    const result: StepResult = { status: partial.status, logs };
    if (partial.output !== undefined)
      result.output = redactor.redact(partial.output, paths) as JsonValue;
    if (partial.artifacts) result.artifacts = partial.artifacts;
    if (partial.error) {
      result.error = {
        ...partial.error,
        message: redactor.redactText(partial.error.message),
        ...(partial.error.detail ? { detail: redactor.redactText(partial.error.detail) } : {}),
      };
    }
    return {
      result,
      maskedInput,
      durationMs: Math.max(context.clock.now().getTime() - started, 0),
    };
  };

  if (context.signal.aborted)
    throw new PlatformError('EXECUTION_CANCELLED', 'The Step was cancelled before it started.');

  const issues = validateStepConfig(definition as StepDefinition<never>, config);
  const semantic = issues.length === 0 ? definition.validate(config, options.validation ?? {}) : [];
  if (issues.length + semantic.length > 0) {
    const all = [...issues, ...semantic];
    return finish({
      status: 'Failed',
      error: {
        code: 'VALIDATION_SCHEMA',
        message: 'Step configuration is invalid.',
        detail: describeIssues(all),
      },
    });
  }

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), options.timeoutMs);
  const signal = AbortSignal.any([context.signal, timeout.signal]);

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () =>
      reject(
        context.signal.aborted
          ? new PlatformError('EXECUTION_CANCELLED', 'The Step was cancelled.')
          : new PlatformError(
              'EXECUTION_TIMEOUT',
              `The Step exceeded its ${options.timeoutMs} ms timeout.`,
              { retryable: true },
            ),
      );
    signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => undefined);

  try {
    const result = await Promise.race([
      definition.execute({ ...context, signal, logger }, config),
      aborted,
    ]);
    if (result.status === 'Failed' && !result.error) {
      return finish({
        status: 'Failed',
        output: result.output,
        error: { code: 'SYSTEM_INTERNAL', message: 'The Step failed without an error.' },
      });
    }
    return finish({
      status: result.status,
      output: result.output,
      error: result.error,
      artifacts: result.artifacts,
    });
  } catch (error) {
    if (error instanceof PlatformError && error.code === 'EXECUTION_CANCELLED') {
      if (context.signal.aborted || !timeout.signal.aborted) throw error;
      // The Step observed our timeout abort; report it as a timeout, not a user cancellation.
      return finish({
        status: 'Failed',
        error: toErrorInfo(
          new PlatformError(
            'EXECUTION_TIMEOUT',
            `The Step exceeded its ${options.timeoutMs} ms timeout.`,
          ),
        ),
      });
    }
    if (!(error instanceof PlatformError))
      logger.error('Unexpected error while executing the Step.');
    return finish({ status: 'Failed', error: toErrorInfo(error) });
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
};
