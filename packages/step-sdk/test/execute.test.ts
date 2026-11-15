import { afterEach, describe, expect, it, vi } from 'vitest';
import { REDACTED, PlatformError, createRedactor, type Clock } from '@test-platform/core';
import { executeStep, type StepDefinition } from '../src/index.js';
import { makeContext } from './helpers.js';

const schema = {
  type: 'object',
  required: ['n'],
  additionalProperties: false,
  properties: { n: { type: 'number' } },
};

const step = (
  execute: StepDefinition<{ n: number }>['execute'],
  extra: Partial<StepDefinition<{ n: number }>> = {},
): StepDefinition<unknown> =>
  ({
    type: 'test.step',
    displayName: 'Test',
    configSchema: schema,
    validate: () => [],
    execute,
    ...extra,
  }) as StepDefinition<unknown>;

afterEach(() => vi.useRealTimers());

describe('executeStep', () => {
  it('returns the result, masked input, and logs on success', async () => {
    const definition = step(async (ctx, config) => {
      ctx.logger.info('working', { n: config.n });
      return { status: 'Succeeded', output: { doubled: config.n * 2 }, logs: ctx.logger.entries() };
    });
    const outcome = await executeStep(definition, { n: 2 }, makeContext(), { timeoutMs: 1000 });
    expect(outcome.result).toMatchObject({ status: 'Succeeded', output: { doubled: 4 } });
    expect(outcome.result.logs.map((l) => l.message)).toEqual(['working']);
    expect(outcome.maskedInput).toEqual({ n: 2 });
  });

  it('fails with VALIDATION_SCHEMA and does not execute when the config is invalid', async () => {
    const execute = vi.fn();
    const outcome = await executeStep(step(execute), { n: 'x', extra: 1 }, makeContext(), {
      timeoutMs: 1000,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(outcome.result.status).toBe('Failed');
    expect(outcome.result.error).toMatchObject({ code: 'VALIDATION_SCHEMA' });
    expect(outcome.result.error?.detail).toContain('/n');
  });

  it('applies the Step semantic validation after the schema', async () => {
    const definition = step(vi.fn(), { validate: () => [{ path: '/n', message: 'must be even' }] });
    const outcome = await executeStep(definition, { n: 3 }, makeContext(), { timeoutMs: 1000 });
    expect(outcome.result.error?.detail).toContain('must be even');
  });

  it('times out a Step that ignores cancellation', async () => {
    vi.useFakeTimers();
    const definition = step(() => new Promise(() => undefined));
    const pending = executeStep(definition, { n: 1 }, makeContext(), { timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    const outcome = await pending;
    expect(outcome.result.error?.code).toBe('EXECUTION_TIMEOUT');
  });

  it('reports a timeout (not a cancellation) when the Step observes the abort signal', async () => {
    vi.useFakeTimers();
    const definition = step(
      (ctx) =>
        new Promise((_, reject) => {
          ctx.signal.addEventListener('abort', () =>
            reject(new PlatformError('EXECUTION_CANCELLED', 'aborted')),
          );
        }),
    );
    const pending = executeStep(definition, { n: 1 }, makeContext(), { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).result.error?.code).toBe('EXECUTION_TIMEOUT');
  });

  it('rejects with EXECUTION_CANCELLED when the caller cancels mid-run', async () => {
    const controller = new AbortController();
    const definition = step(() => new Promise(() => undefined));
    const pending = executeStep(definition, { n: 1 }, makeContext({ signal: controller.signal }), {
      timeoutMs: 60_000,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'EXECUTION_CANCELLED' });
  });

  it('rejects before starting when already cancelled', async () => {
    const execute = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeStep(step(execute), { n: 1 }, makeContext({ signal: controller.signal }), {
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      code: 'EXECUTION_CANCELLED',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('maps unexpected errors to a generic SYSTEM_INTERNAL failure without leaking the message', async () => {
    const definition = step(async () => {
      throw new Error('connection string: AccountKey=abc123');
    });
    const outcome = await executeStep(definition, { n: 1 }, makeContext(), { timeoutMs: 1000 });
    expect(outcome.result.error).toEqual({
      code: 'SYSTEM_INTERNAL',
      message: 'An unexpected internal error occurred.',
    });
    expect(JSON.stringify(outcome)).not.toContain('AccountKey');
  });

  it('keeps PlatformError codes and normalizes a Failed result without an error', async () => {
    const coded = step(async () => {
      throw new PlatformError('TARGET_SERVICE', 'upstream 503');
    });
    expect(
      (await executeStep(coded, { n: 1 }, makeContext(), { timeoutMs: 1000 })).result.error?.code,
    ).toBe('TARGET_SERVICE');

    const bare = step(async (ctx) => ({ status: 'Failed', logs: ctx.logger.entries() }));
    expect(
      (await executeStep(bare, { n: 1 }, makeContext(), { timeoutMs: 1000 })).result.error?.code,
    ).toBe('SYSTEM_INTERNAL');
  });

  it('masks sensitive paths and registered secret values in input, output, logs, and errors', async () => {
    const definition = step(
      async (ctx) => {
        ctx.logger.info('sending with s3cr3t-value', {
          nested: { apiKey: 'k', note: 's3cr3t-value' },
        });
        return {
          status: 'Failed',
          output: { header: 'Bearer s3cr3t-value', hidden: 'x' },
          logs: ctx.logger.entries(),
          error: {
            code: 'TARGET_REQUEST',
            message: 'rejected s3cr3t-value',
            detail: 'token s3cr3t-value',
          },
        };
      },
      {
        sensitivePaths: ['hidden'],
        configSchema: { type: 'object', additionalProperties: true },
      },
    );
    const redactor = createRedactor({ secretValues: () => ['s3cr3t-value'] });
    const outcome = await executeStep(
      definition,
      { n: 1, password: 'p', url: 'x?s3cr3t-value' },
      makeContext(),
      { timeoutMs: 1000, redactor },
    );

    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain('s3cr3t-value');
    expect(outcome.maskedInput).toEqual({ n: 1, password: REDACTED, url: `x?${REDACTED}` });
    expect(outcome.result.output).toEqual({ header: `Bearer ${REDACTED}`, hidden: REDACTED });
    expect(outcome.result.logs[0]?.data).toEqual({ nested: { apiKey: REDACTED, note: REDACTED } });
  });

  it('measures duration with the injected clock', async () => {
    let now = 1_000;
    const clock: Clock = { now: () => new Date(now) };
    const definition = step(async (ctx) => {
      now += 250;
      return { status: 'Succeeded', logs: ctx.logger.entries() };
    });
    expect(
      (await executeStep(definition, { n: 1 }, makeContext({ clock }), { timeoutMs: 1000 }))
        .durationMs,
    ).toBe(250);
  });
});
