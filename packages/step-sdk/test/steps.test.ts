import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@test-platform/contracts';
import {
  assertStep,
  createBuiltInRegistry,
  delayStep,
  executeStep,
  StepRegistry,
  transformJsonStep,
  type StepDefinition,
} from '../src/index.js';
import { makeContext } from './helpers.js';

const run = (definition: StepDefinition<never>, config: JsonValue, signal?: AbortSignal) =>
  executeStep(
    definition as StepDefinition<unknown>,
    config,
    makeContext(signal ? { signal } : {}),
    { timeoutMs: 5000 },
  );

describe('StepRegistry', () => {
  it('registers built-ins and describes them for the catalog', () => {
    const registry = createBuiltInRegistry();
    expect(registry.describe().map((m) => m.type)).toEqual([
      'assert',
      'blob.download',
      'blob.upload',
      'breakpoint',
      'delay',
      'http.request',
      'serviceBus.send',
      'sql.execute',
      'sql.query',
      'transform.json',
      'waitForCondition',
    ]);
    const external = registry
      .describe()
      .filter((m) => m.capabilities.external)
      .map((m) => m.type);
    expect(external).toEqual([
      'blob.download',
      'blob.upload',
      'http.request',
      'serviceBus.send',
      'sql.execute',
      'sql.query',
      'waitForCondition',
    ]);
    expect(registry.has('delay')).toBe(true);
    expect(registry.get('nope')).toBeUndefined();
    expect(() => registry.require('nope')).toThrow('Unknown Step type');
  });

  it('rejects duplicate registration and uncompilable schemas', () => {
    const registry = new StepRegistry().register(delayStep);
    expect(() => registry.register(delayStep)).toThrow('already registered');
    expect(() =>
      registry.register({ ...delayStep, type: 'broken', configSchema: { type: 'not-a-type' } }),
    ).toThrow();
  });
});

describe('delay', () => {
  it('waits and reports the actual duration', async () => {
    const outcome = await run(delayStep as never, { durationSeconds: 0.02 });
    expect(outcome.result.status).toBe('Succeeded');
    expect(
      (outcome.result.output as { actualDurationMs: number }).actualDurationMs,
    ).toBeGreaterThanOrEqual(15);
  });

  it('is interrupted by cancellation', async () => {
    const controller = new AbortController();
    const pending = run(delayStep as never, { durationSeconds: 60 }, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ code: 'EXECUTION_CANCELLED' });
  });

  it('is bounded by the Step timeout', async () => {
    const outcome = await executeStep(
      delayStep as StepDefinition<unknown>,
      { durationSeconds: 60 },
      makeContext(),
      { timeoutMs: 20 },
    );
    expect(outcome.result.error?.code).toBe('EXECUTION_TIMEOUT');
  });

  it.each([
    { durationSeconds: -1 },
    { durationSeconds: 99999 },
    { durationSeconds: 'x' },
    {},
    { durationSeconds: 1, extra: true },
  ])('rejects invalid config %j', async (config) => {
    expect((await run(delayStep as never, config as JsonValue)).result.error?.code).toBe(
      'VALIDATION_SCHEMA',
    );
  });
});

describe('transform.json', () => {
  const input = {
    order: {
      id: 'O1',
      lines: [
        { sku: 'A', qty: 2 },
        { sku: 'B', qty: 1 },
      ],
    },
    'a-b': 1,
  };

  it('maps selectors, literals, nested objects, and arrays', async () => {
    const outcome = await run(transformJsonStep as never, {
      input,
      mapping: {
        id: '$.order.id',
        firstSku: '$.order.lines[0].sku',
        hyphen: '$.a-b',
        whole: '$',
        constants: ['plain', 5, true, null, { $literal: '$.not-a-selector' }],
        nested: { total: '$.order.lines.1.qty' },
      },
    });
    expect(outcome.result.output).toEqual({
      id: 'O1',
      firstSku: 'A',
      hyphen: 1,
      whole: input,
      constants: ['plain', 5, true, null, '$.not-a-selector'],
      nested: { total: 1 },
    });
  });

  it('passes input through without a mapping', async () => {
    expect((await run(transformJsonStep as never, { input: { a: 1 } })).result.output).toEqual({
      a: 1,
    });
  });

  it('fails with EXECUTION_TRANSFORM_FAILED when a selector matches nothing', async () => {
    const outcome = await run(transformJsonStep as never, {
      input,
      mapping: { x: '$.order.missing' },
    });
    expect(outcome.result).toMatchObject({
      status: 'Failed',
      error: { code: 'EXECUTION_TRANSFORM_FAILED' },
    });
  });

  it('rejects malformed or dangerous selectors during validation', async () => {
    for (const selector of ['$.a b', '$..a', '$.a[x]', '$.__proto__.x', '$.constructor']) {
      const outcome = await run(transformJsonStep as never, {
        input: {},
        mapping: { x: selector },
      });
      expect(outcome.result.error?.code, selector).toBe('VALIDATION_SCHEMA');
    }
  });

  it('does not read inherited properties', async () => {
    const outcome = await run(transformJsonStep as never, {
      input: { a: 1 },
      mapping: { x: '$.toString' },
    });
    expect(outcome.result.error?.code).toBe('EXECUTION_TRANSFORM_FAILED');
  });
});

describe('assert', () => {
  const evaluate = async (config: Record<string, JsonValue>) =>
    (await run(assertStep as never, config)).result;

  it.each<[string, JsonValue, JsonValue | undefined, boolean]>([
    ['equals', { a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }, true],
    ['equals', { a: 1, b: 2 }, { b: 2, a: 1 }, true],
    ['equals', 1, '1', false],
    ['equals', [1, 2], [2, 1], false],
    ['notEquals', 'a', 'b', true],
    ['contains', 'hello world', 'lo w', true],
    ['contains', [1, { a: 1 }], { a: 1 }, true],
    ['contains', { key: 1 }, 'key', true],
    ['notContains', 'abc', 'z', true],
    ['greaterThan', 3, 2, true],
    ['greaterThanOrEqual', 2, 2, true],
    ['lessThan', 'a', 'b', true],
    ['lessThanOrEqual', 3, 2, false],
    ['matches', 'ORD-123', '^ORD-\\d+$', true],
    ['matches', 'xyz', '^ORD', false],
    ['exists', 'x', undefined, true],
    ['exists', null, undefined, false],
    ['notExists', null, undefined, true],
  ])('%s(%j, %j) -> %s', async (operator, actual, expected, passes) => {
    const config: Record<string, JsonValue> = { actual, operator };
    if (expected !== undefined) config.expected = expected;
    const result = await evaluate(config);
    expect(result.status).toBe(passes ? 'Succeeded' : 'Failed');
    expect((result.output as { passed: boolean }).passed).toBe(passes);
  });

  it('fails with a diagnostic, optional custom message, and EXECUTION_ASSERTION_FAILED', async () => {
    const result = await evaluate({
      actual: 'ORD-1',
      operator: 'equals',
      expected: 'ORD-2',
      message: 'Order id mismatch',
    });
    expect(result.status).toBe('Failed');
    expect(result.error).toEqual({
      code: 'EXECUTION_ASSERTION_FAILED',
      message: 'Order id mismatch (Expected "ORD-1" equals "ORD-2")',
    });
    expect(result.logs.at(-1)?.level).toBe('error');
  });

  it('truncates long values in diagnostics', async () => {
    const result = await evaluate({ actual: 'x'.repeat(5000), operator: 'equals', expected: 'y' });
    expect(result.error?.message.length).toBeLessThan(400);
  });

  it('fails clearly on type mismatches', async () => {
    expect(
      (await evaluate({ actual: 1, operator: 'contains', expected: 1 })).error?.message,
    ).toContain('cannot be applied');
    expect(
      (await evaluate({ actual: 'a', operator: 'greaterThan', expected: 1 })).error?.message,
    ).toContain('two numbers or two strings');
  });

  it('requires expected for operators that compare', async () => {
    const result = await evaluate({ actual: 1, operator: 'equals' });
    expect(result.error).toMatchObject({ code: 'VALIDATION_SCHEMA' });
    expect(result.error?.detail).toContain('/expected');
  });

  it('rejects unknown operators and unsafe regular expressions', async () => {
    expect(
      (await evaluate({ actual: 1, operator: 'approximately', expected: 1 })).error?.code,
    ).toBe('VALIDATION_SCHEMA');
    expect(
      (await evaluate({ actual: 'aaa', operator: 'matches', expected: '(a+)+$' })).error?.code,
    ).toBe('VALIDATION_SCHEMA');
    expect(
      (await evaluate({ actual: 'aaa', operator: 'matches', expected: '[' })).error?.code,
    ).toBe('VALIDATION_SCHEMA');
    expect(
      (await evaluate({ actual: 'aaa', operator: 'matches', expected: 'a'.repeat(300) })).error
        ?.code,
    ).toBe('VALIDATION_SCHEMA');
  });
});
