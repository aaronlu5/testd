import type { JsonValue } from '@test-platform/contracts';
import { ExpressionError, parseTemplate, type Reference } from './parse.js';

export type ExpressionContext = {
  testData: JsonValue;
  variables: Record<string, JsonValue>;
  /** Explicitly non-secret environment values only. */
  environment: Record<string, string | number | boolean>;
  /** Outputs of steps that have already completed. */
  steps: Record<string, { output: JsonValue }>;
  /** Per-Run global variables (letters, digits and hyphens only). */
  global?: Record<string, string | number>;
};

const MAX_DEPTH = 64;

const walk = (start: unknown, path: string[], raw: string): JsonValue => {
  let current = start;
  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new ExpressionError(
          `Expression "${raw}" refers to a missing array element "${segment}".`,
        );
      }
      current = current[index];
    } else if (typeof current === 'object' && current !== null && Object.hasOwn(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      throw new ExpressionError(`Expression "${raw}" refers to a missing value at "${segment}".`);
    }
  }
  if (current === undefined) throw new ExpressionError(`Expression "${raw}" resolved to no value.`);
  return current as JsonValue;
};

export const resolveReference = (reference: Reference, context: ExpressionContext): JsonValue => {
  const { root, path, raw } = reference;
  if (root === 'steps') {
    const [nodeId, , ...rest] = path as [string, string, ...string[]];
    if (!Object.hasOwn(context.steps, nodeId)) {
      throw new ExpressionError(`Output of step "${nodeId}" is not available in "${raw}".`);
    }
    return walk(context.steps[nodeId]!.output, rest, raw);
  }
  return walk(root === 'global' ? (context.global ?? {}) : context[root], path, raw);
};

const stringify = (value: JsonValue): string =>
  typeof value === 'string'
    ? value
    : typeof value === 'object' && value !== null
      ? JSON.stringify(value)
      : String(value);

export const resolveTemplate = (source: string, context: ExpressionContext): JsonValue => {
  const parsed = parseTemplate(source);
  if (parsed.isSingleExpression) {
    const only = parsed.segments[0];
    if (only?.kind === 'expression') return resolveReference(only.reference, context);
  }
  return parsed.segments
    .map((segment) =>
      segment.kind === 'text'
        ? segment.text
        : stringify(resolveReference(segment.reference, context)),
    )
    .join('');
};

/** Resolves expressions in every string value; object keys are never resolved. */
export const resolveValue = (
  value: JsonValue,
  context: ExpressionContext,
  depth = 0,
): JsonValue => {
  if (depth > MAX_DEPTH) throw new ExpressionError('Value is nested too deeply to resolve.');
  if (typeof value === 'string') return resolveTemplate(value, context);
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, context, depth + 1));
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value))
      result[key] = resolveValue(item, context, depth + 1);
    return result;
  }
  return value;
};
