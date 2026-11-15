import type { JsonValue, ValidationIssue } from '@test-platform/contracts';
import type { StepDefinition } from '../types.js';

export const ASSERT_OPERATORS = [
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual',
  'matches',
  'exists',
  'notExists',
] as const;
export type AssertOperator = (typeof ASSERT_OPERATORS)[number];

export type AssertConfig = {
  actual: JsonValue;
  operator: AssertOperator;
  expected?: JsonValue;
  message?: string;
};

const NO_EXPECTED: ReadonlySet<AssertOperator> = new Set(['exists', 'notExists']);
const NUMERIC: ReadonlySet<AssertOperator> = new Set([
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual',
]);
const MAX_PATTERN_LENGTH = 200;
const MAX_MATCH_INPUT = 100_000;
const PREVIEW_LENGTH = 200;
// Nested quantifiers such as (a+)+ can backtrack catastrophically; reject them outright.
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/;

export const deepEqual = (a: JsonValue, b: JsonValue): boolean => {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => deepEqual(item, b[index] as JsonValue))
    );
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a);
    return (
      keysA.length === Object.keys(b).length &&
      keysA.every(
        (key) => Object.hasOwn(b, key) && deepEqual(a[key] as JsonValue, b[key] as JsonValue),
      )
    );
  }
  return false;
};

const preview = (value: JsonValue | undefined): string => {
  const text =
    typeof value === 'string' ? JSON.stringify(value) : (JSON.stringify(value) ?? 'undefined');
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}…` : text;
};

const contains = (actual: JsonValue, expected: JsonValue): boolean | undefined => {
  if (typeof actual === 'string')
    return typeof expected === 'string' ? actual.includes(expected) : undefined;
  if (Array.isArray(actual)) return actual.some((item) => deepEqual(item, expected));
  if (typeof actual === 'object' && actual !== null)
    return typeof expected === 'string' ? Object.hasOwn(actual, expected) : undefined;
  return undefined;
};

const compileRegex = (pattern: string): RegExp | string => {
  if (pattern.length > MAX_PATTERN_LENGTH)
    return `pattern is longer than ${MAX_PATTERN_LENGTH} characters`;
  if (NESTED_QUANTIFIER.test(pattern))
    return 'pattern contains nested quantifiers, which are not allowed';
  try {
    return new RegExp(pattern, 'u');
  } catch {
    return 'pattern is not a valid regular expression';
  }
};

type Evaluation = { passed: boolean; problem?: string };

const evaluate = (config: AssertConfig): Evaluation => {
  const { actual, operator, expected } = config;
  const exp = expected as JsonValue;
  switch (operator) {
    case 'exists':
      return { passed: actual !== null };
    case 'notExists':
      return { passed: actual === null };
    case 'equals':
      return { passed: deepEqual(actual, exp) };
    case 'notEquals':
      return { passed: !deepEqual(actual, exp) };
    case 'contains':
    case 'notContains': {
      const result = contains(actual, exp);
      if (result === undefined)
        return { passed: false, problem: `"${operator}" cannot be applied to these value types` };
      return { passed: operator === 'contains' ? result : !result };
    }
    case 'matches': {
      if (typeof actual !== 'string' || typeof exp !== 'string')
        return { passed: false, problem: '"matches" requires string values' };
      if (actual.length > MAX_MATCH_INPUT)
        return { passed: false, problem: 'value is too long for "matches"' };
      const regex = compileRegex(exp);
      return typeof regex === 'string'
        ? { passed: false, problem: regex }
        : { passed: regex.test(actual) };
    }
    default: {
      const comparable =
        (typeof actual === 'number' && typeof exp === 'number') ||
        (typeof actual === 'string' && typeof exp === 'string');
      if (!comparable)
        return { passed: false, problem: `"${operator}" requires two numbers or two strings` };
      const a = actual as number | string;
      const b = exp as number | string;
      if (operator === 'greaterThan') return { passed: a > b };
      if (operator === 'greaterThanOrEqual') return { passed: a >= b };
      if (operator === 'lessThan') return { passed: a < b };
      return { passed: a <= b };
    }
  }
};

export const assertStep: StepDefinition<AssertConfig> = {
  type: 'assert',
  displayName: 'Assert',
  description:
    'Compares a resolved value with an expected value and fails the Run when the assertion does not hold.',
  configSchema: {
    type: 'object',
    required: ['actual', 'operator'],
    additionalProperties: false,
    properties: {
      actual: {},
      operator: { enum: [...ASSERT_OPERATORS] },
      expected: {},
      message: { type: 'string', maxLength: 500 },
    },
  },
  sensitivePaths: [],
  defaults: { operator: 'equals' },
  capabilities: { external: false, supportsRetry: false, supportsArtifacts: false },
  validate(config) {
    const issues: ValidationIssue[] = [];
    if (!NO_EXPECTED.has(config.operator) && !Object.hasOwn(config, 'expected')) {
      issues.push({
        path: '/expected',
        message: `is required for operator "${config.operator}"`,
        keyword: 'required',
      });
      return issues;
    }
    if (
      NUMERIC.has(config.operator) &&
      typeof config.expected !== 'number' &&
      typeof config.expected !== 'string'
    ) {
      issues.push({
        path: '/expected',
        message: `must be a number or string for operator "${config.operator}"`,
        keyword: 'type',
      });
    }
    if (config.operator === 'matches') {
      const regex =
        typeof config.expected === 'string' ? compileRegex(config.expected) : 'must be a string';
      if (typeof regex === 'string')
        issues.push({ path: '/expected', message: regex, keyword: 'pattern' });
    }
    return issues;
  },
  async execute(context, config) {
    const { passed, problem } = evaluate(config);
    const output: JsonValue = {
      passed,
      operator: config.operator,
      actual: config.actual,
      ...(Object.hasOwn(config, 'expected') ? { expected: config.expected as JsonValue } : {}),
    };
    if (passed) {
      context.logger.info(`Assertion passed: ${config.operator}`);
      return { status: 'Succeeded', output, logs: context.logger.entries() };
    }

    const diagnostic =
      problem ??
      `Expected ${preview(config.actual)} ${config.operator}${NO_EXPECTED.has(config.operator) ? '' : ` ${preview(config.expected)}`}`;
    const message = config.message ? `${config.message} (${diagnostic})` : diagnostic;
    context.logger.error(message);
    return {
      status: 'Failed',
      output,
      logs: context.logger.entries(),
      error: { code: 'EXECUTION_ASSERTION_FAILED', message },
    };
  },
};
