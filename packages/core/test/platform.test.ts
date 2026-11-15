import { describe, expect, it, vi } from 'vitest';
import {
  PlatformError,
  assertRunTransition,
  assertStepRunTransition,
  cancellableSleep,
  computeBackoffMs,
  createRedactor,
  createTargetResolver,
  decideRunTransition,
  decideStepRunTransition,
  effectiveRetryPolicy,
  errorFamily,
  isCancellationRequested,
  isTerminalRunStatus,
  redactText,
  redactValue,
  shouldRetry,
  toErrorInfo,
  REDACTED,
} from '../src/index.js';

describe('run state machine', () => {
  it.each([
    ['Queued', 'Running'],
    ['Queued', 'Cancelled'],
    ['Running', 'Succeeded'],
    ['Running', 'Failed'],
    ['Running', 'Cancelling'],
    ['Running', 'Queued'],
    ['Cancelling', 'Cancelled'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(decideRunTransition(from, to)).toBe('apply');
  });

  it.each([
    ['Queued', 'Succeeded'],
    ['Succeeded', 'Running'],
    ['Failed', 'Queued'],
    ['Cancelled', 'Running'],
    ['Cancelling', 'Succeeded'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(decideRunTransition(from, to)).toBe('reject');
    expect(() => assertRunTransition(from, to)).toThrow(PlatformError);
  });

  it('treats repeating the current state as an idempotent no-op', () => {
    expect(decideRunTransition('Succeeded', 'Succeeded')).toBe('noop');
    expect(assertRunTransition('Running', 'Running')).toBe('noop');
  });

  it('knows terminal states', () => {
    expect(
      ['Succeeded', 'Failed', 'Cancelled'].every((s) => isTerminalRunStatus(s as 'Failed')),
    ).toBe(true);
    expect(isTerminalRunStatus('Running')).toBe(false);
  });
});

describe('step-run state machine', () => {
  it('supports the retry loop and terminal states', () => {
    expect(decideStepRunTransition('Running', 'Retrying')).toBe('apply');
    expect(decideStepRunTransition('Retrying', 'Running')).toBe('apply');
    expect(decideStepRunTransition('Queued', 'Skipped')).toBe('apply');
    expect(decideStepRunTransition('Succeeded', 'Running')).toBe('reject');
    expect(() => assertStepRunTransition('Failed', 'Retrying')).toThrow('Step run cannot move');
  });
});

describe('retry and backoff', () => {
  const policy = effectiveRetryPolicy({
    maxAttempts: 5,
    initialDelayMs: 100,
    backoffMultiplier: 2,
    maxDelayMs: 500,
  });

  it('grows exponentially and caps at maxDelayMs', () => {
    expect([1, 2, 3, 4, 5].map((attempt) => computeBackoffMs(attempt, policy))).toEqual([
      100, 200, 400, 500, 500,
    ]);
  });

  it('applies full jitter when a random source is supplied', () => {
    expect(computeBackoffMs(3, policy, () => 0.5)).toBe(200);
    expect(computeBackoffMs(3, policy, () => 0)).toBe(0);
  });

  it('clamps attempts to environment limits and defaults to a single attempt', () => {
    expect(effectiveRetryPolicy({ maxAttempts: 10 }, { maxRetryAttempts: 3 }).maxAttempts).toBe(3);
    expect(effectiveRetryPolicy().maxAttempts).toBe(1);
  });

  it('retries only retryable failures within the attempt budget', () => {
    expect(shouldRetry(1, policy, true)).toBe(true);
    expect(shouldRetry(5, policy, true)).toBe(false);
    expect(shouldRetry(1, policy, false)).toBe(false);
  });
});

describe('cancellation', () => {
  it('detects requested cancellation from run state', () => {
    expect(isCancellationRequested({ status: 'Running' })).toBe(false);
    expect(
      isCancellationRequested({ status: 'Running', cancelRequestedAt: '2026-01-01T00:00:00.000Z' }),
    ).toBe(true);
    expect(isCancellationRequested({ status: 'Cancelling' })).toBe(true);
  });

  it('sleeps for the requested time', async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const sleeping = cancellableSleep(1000).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await sleeping;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects promptly when aborted during or before the wait', async () => {
    const controller = new AbortController();
    const sleeping = cancellableSleep(60_000, controller.signal);
    controller.abort();
    await expect(sleeping).rejects.toMatchObject({ code: 'EXECUTION_CANCELLED' });
    await expect(cancellableSleep(10, controller.signal)).rejects.toMatchObject({
      code: 'EXECUTION_CANCELLED',
    });
  });
});

describe('error taxonomy', () => {
  it('derives families and retryability from codes', () => {
    expect(errorFamily('TARGET_TIMEOUT')).toBe('TARGET');
    expect(errorFamily('VALIDATION_FLOW')).toBe('VALIDATION');
    expect(new PlatformError('TARGET_SERVICE', 'x').retryable).toBe(true);
    expect(new PlatformError('VALIDATION_SCHEMA', 'x').retryable).toBe(false);
  });

  it('never leaks unknown error messages', () => {
    expect(toErrorInfo(new Error('password=hunter2'))).toEqual({
      code: 'SYSTEM_INTERNAL',
      message: 'An unexpected internal error occurred.',
    });
    expect(toErrorInfo(new PlatformError('AUTH_FORBIDDEN', 'Nope', { detail: 'policy' }))).toEqual({
      code: 'AUTH_FORBIDDEN',
      message: 'Nope',
      detail: 'policy',
    });
  });
});

describe('redaction', () => {
  it('masks well-known sensitive keys case-insensitively, including nested values', () => {
    const result = redactValue({
      headers: { Authorization: 'Bearer abc', 'X-Api-Key': 'k', Accept: 'json' },
      body: { password: 'p', accessToken: 't', tokenCount: 3, list: [{ clientSecret: 's' }] },
    });
    expect(result).toEqual({
      headers: { Authorization: REDACTED, 'X-Api-Key': REDACTED, Accept: 'json' },
      body: {
        password: REDACTED,
        accessToken: REDACTED,
        tokenCount: 3,
        list: [{ clientSecret: REDACTED }],
      },
    });
  });

  it('masks declared sensitive paths, including wildcards', () => {
    const result = redactValue(
      { a: { b: 'x' }, items: [{ pin: '1' }, { pin: '2' }], keep: 'y' },
      { sensitivePaths: ['$.a.b', 'items.*.PIN'] },
    );
    expect(result).toEqual({
      a: { b: REDACTED },
      items: [{ pin: REDACTED }, { pin: REDACTED }],
      keep: 'y',
    });
  });

  it('removes registered secret values from any string, longest first', () => {
    const result = redactValue(
      { url: 'https://h/?sig=abcd1234', log: 'token abcd1234 and abcd' },
      {
        secretValues: ['abcd', 'abcd1234'],
        maskSensitiveKeys: false,
      },
    );
    expect(result).toEqual({
      url: `https://h/?sig=${REDACTED}`,
      log: `token ${REDACTED} and ${REDACTED}`,
    });
    expect(redactText('ab is short', ['ab'])).toBe('ab is short');
  });

  it('does not mutate input and survives cycles and odd values', () => {
    const input: Record<string, unknown> = {
      name: 'n',
      when: new Date('2026-01-01T00:00:00.000Z'),
      fn: () => 1,
    };
    input.self = input;
    const output = redactValue(input) as Record<string, unknown>;
    expect(output.self).toBe('[Circular]');
    expect(output.when).toBe('2026-01-01T00:00:00.000Z');
    expect(input.self).toBe(input);
  });

  it('does not pollute prototypes from hostile keys', () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":true},"ok":1}');
    const output = redactValue(hostile) as Record<string, unknown>;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(output.ok).toBe(1);
  });

  it('uses secret values registered after the redactor was created', () => {
    const values = new Set<string>();
    const redactor = createRedactor({ secretValues: () => values });
    expect(redactor.redactText('value s3cr3t!')).toBe('value s3cr3t!');
    values.add('s3cr3t!');
    expect(redactor.redactText('value s3cr3t!')).toBe(`value ${REDACTED}`);
    expect(redactor.redact({ a: 's3cr3t!' })).toEqual({ a: REDACTED });
  });
});

describe('target resolver', () => {
  const resolver = createTargetResolver({
    id: 'env',
    targets: { api: { kind: 'http', baseUrl: 'https://example.invalid', allowedPaths: ['/x'] } },
  });

  it('resolves configured targets of the expected kind', () => {
    expect(resolver.resolve('api', 'http').baseUrl).toBe('https://example.invalid');
  });

  it('rejects unknown names, wrong kinds, and raw URLs', () => {
    expect(() => resolver.resolve('missing', 'http')).toThrow(PlatformError);
    expect(() => resolver.resolve('api', 'azureBlob')).toThrow('not "azureBlob"');
    expect(() => resolver.resolve('https://evil.example', 'http')).toThrow('not configured');
    expect(() => resolver.resolve('toString', 'http')).toThrow('not configured');
  });
});
