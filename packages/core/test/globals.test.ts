import { describe, expect, it } from 'vitest';
import {
  ExpressionError,
  GLOBAL_NAMES,
  GLOBAL_VALUE_PATTERN,
  GLOBAL_VARIABLES,
  computeGlobals,
  globalReferenceProblems,
  resolveTemplate,
  resolveTestData,
  resolveVariables,
  validateExpressions,
} from '../src/index.js';

const source = {
  runId: '2752a210-2d84-4b84-ac82-761b9e52a85b',
  runNumber: 7,
  requestedAt: '2026-10-20T10:15:30.123Z',
  testId: '5b0c1f2e-7d1a-4d57-9d3b-0a5d0f1e2c3d',
  testVersion: 3,
  environmentId: 'orders-test',
  environmentClassification: 'TEST',
};

describe('computeGlobals', () => {
  it('derives every documented variable', () => {
    const globals = computeGlobals(source);
    expect(Object.keys(globals).sort()).toEqual([...GLOBAL_NAMES].sort());
    expect(globals).toMatchObject({
      runId: source.runId,
      runNumber: 7,
      runTimestamp: Date.parse(source.requestedAt),
      runStartedAt: '20261020T101530Z',
      runDate: '20261020',
      testVersion: 3,
      environmentId: 'orders-test',
      environmentClassification: 'TEST',
    });
  });

  it('only produces letters, digits and hyphens', () => {
    for (const value of Object.values(computeGlobals(source)))
      expect(String(value)).toMatch(GLOBAL_VALUE_PATTERN);
  });

  it('is stable for a Run, new for another Run, and stable per Test', () => {
    const first = computeGlobals(source);
    expect(computeGlobals(source)).toEqual(first);
    const other = computeGlobals({ ...source, runId: 'another-run', runNumber: 8 });
    expect(other.runSeed).not.toBe(first.runSeed);
    expect(other.runId).not.toBe(first.runId);
    expect(other.testId).toBe(first.testId);
    expect(first.testId).toMatch(/^t-[0-9a-f]{10}$/);
  });

  it('leaves out what a Run does not have', () => {
    const globals = computeGlobals({ ...source, runNumber: undefined, testId: undefined });
    expect(globals).not.toHaveProperty('runNumber');
    expect(globals).not.toHaveProperty('testId');
  });

  it('documents each variable with a valid example', () => {
    for (const variable of GLOBAL_VARIABLES) {
      expect(variable.description.length).toBeGreaterThan(10);
      expect(variable.example).toMatch(GLOBAL_VALUE_PATTERN);
    }
  });
});

describe('global expressions', () => {
  const globals = computeGlobals(source);

  it('resolves in templates and keeps numbers numeric', () => {
    const context = { testData: {}, variables: {}, environment: {}, steps: {}, global: globals };
    expect(resolveTemplate('order-{{ global.runNumber }}', context)).toBe('order-7');
    expect(resolveTemplate('{{ global.runNumber }}', context)).toBe(7);
    expect(() => resolveTemplate('{{ global.nope }}', context)).toThrow(ExpressionError);
  });

  it('resolves Test Data and feeds it to variables', () => {
    const data = resolveTestData(
      { order: { id: 'ORD-{{ global.runSeed }}', n: '{{ global.runNumber }}' }, plain: 1 },
      globals,
    );
    expect(data).toEqual({ order: { id: `ORD-${globals.runSeed}`, n: 7 }, plain: 1 });
    const variables = resolveVariables(
      { orderId: '{{ testData.order.id }}', run: '{{ global.runId }}' },
      { testData: data, environment: {}, global: globals },
    );
    expect(variables).toEqual({ orderId: `ORD-${globals.runSeed}`, run: source.runId });
  });

  it('only allows known global variables in Test Data', () => {
    expect(globalReferenceProblems('{{ global.runId }}-{{ global.testId }}')).toEqual([]);
    expect(globalReferenceProblems('{{ global.unknown }}')[0]).toContain('not a global variable');
    expect(globalReferenceProblems('{{ variables.a }}')[0]).toContain('only use global');
  });

  it('flags unknown globals when a Test is validated', () => {
    const test = {
      variables: { a: '{{ global.runId }}', b: '{{ global.bogus }}' },
      nodes: [],
    };
    const issues = validateExpressions(test as never, { order: [] });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('/variables/b');
  });
});
