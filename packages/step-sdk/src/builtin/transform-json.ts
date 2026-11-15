import type { JsonValue, ValidationIssue } from '@test-platform/contracts';
import { PlatformError } from '@test-platform/core';
import type { StepDefinition } from '../types.js';

export type TransformConfig = { input: JsonValue; mapping?: JsonValue };

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_-]*/;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 32;

/** Parses `$`, `$.a.b`, or `$.a[0].b` into path segments. */
const parseSelector = (selector: string): string[] => {
  if (!selector.startsWith('$')) throw new Error('Selector must start with "$".');
  const segments: string[] = [];
  let rest = selector.slice(1);
  while (rest.length > 0) {
    if (rest.startsWith('.')) {
      const match = SEGMENT.exec(rest.slice(1));
      if (!match) throw new Error(`Invalid selector "${selector}".`);
      segments.push(match[0]);
      rest = rest.slice(1 + match[0].length);
    } else if (rest.startsWith('[')) {
      const close = rest.indexOf(']');
      const index = close === -1 ? '' : rest.slice(1, close);
      if (!/^\d+$/.test(index)) throw new Error(`Invalid index in selector "${selector}".`);
      segments.push(index);
      rest = rest.slice(close + 1);
    } else {
      throw new Error(`Invalid selector "${selector}".`);
    }
  }
  if (segments.some((segment) => FORBIDDEN.has(segment)))
    throw new Error(`Selector "${selector}" uses a forbidden segment.`);
  return segments;
};

const select = (input: JsonValue, selector: string): JsonValue => {
  let current: unknown = input;
  for (const segment of parseSelector(selector)) {
    if (Array.isArray(current) && /^\d+$/.test(segment) && Number(segment) < current.length) {
      current = current[Number(segment)];
    } else if (
      typeof current === 'object' &&
      current !== null &&
      !Array.isArray(current) &&
      Object.hasOwn(current, segment)
    ) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      throw new PlatformError(
        'EXECUTION_TRANSFORM_FAILED',
        `Selector "${selector}" matched nothing at "${segment}".`,
      );
    }
  }
  return current as JsonValue;
};

const isLiteralWrapper = (value: JsonValue): value is { $literal: JsonValue } =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === 1 &&
  Object.hasOwn(value, '$literal');

const applyMapping = (mapping: JsonValue, input: JsonValue, depth = 0): JsonValue => {
  if (depth > MAX_DEPTH)
    throw new PlatformError('EXECUTION_TRANSFORM_FAILED', 'Mapping is nested too deeply.');
  if (typeof mapping === 'string')
    return mapping.startsWith('$') ? select(input, mapping) : mapping;
  if (Array.isArray(mapping)) return mapping.map((item) => applyMapping(item, input, depth + 1));
  if (typeof mapping === 'object' && mapping !== null) {
    if (isLiteralWrapper(mapping)) return mapping.$literal;
    const result: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(mapping)) {
      Object.defineProperty(result, key, {
        value: applyMapping(value, input, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  }
  return mapping;
};

const collectSelectorIssues = (
  mapping: JsonValue,
  path: string,
  issues: ValidationIssue[],
  depth = 0,
): void => {
  if (depth > MAX_DEPTH) {
    issues.push({ path, message: 'Mapping is nested too deeply.' });
  } else if (typeof mapping === 'string') {
    if (mapping.startsWith('$')) {
      try {
        parseSelector(mapping);
      } catch (error) {
        issues.push({ path, message: (error as Error).message });
      }
    }
  } else if (Array.isArray(mapping)) {
    mapping.forEach((item, index) =>
      collectSelectorIssues(item, `${path}/${index}`, issues, depth + 1),
    );
  } else if (typeof mapping === 'object' && mapping !== null && !isLiteralWrapper(mapping)) {
    for (const [key, value] of Object.entries(mapping))
      collectSelectorIssues(value, `${path}/${key}`, issues, depth + 1);
  }
};

export const transformJsonStep: StepDefinition<TransformConfig> = {
  type: 'transform.json',
  displayName: 'Transform JSON',
  description:
    'Reshapes JSON. Mapping strings starting with "$" select from the input ($.a.b[0]); wrap values in {"$literal": ...} to keep them verbatim. Without a mapping the input is passed through.',
  configSchema: {
    type: 'object',
    required: ['input'],
    additionalProperties: false,
    properties: { input: {}, mapping: {} },
  },
  sensitivePaths: [],
  defaults: { input: {}, mapping: {} },
  capabilities: { external: false, supportsRetry: false, supportsArtifacts: false },
  validate(config) {
    const issues: ValidationIssue[] = [];
    if (config.mapping !== undefined) collectSelectorIssues(config.mapping, '/mapping', issues);
    return issues;
  },
  async execute(context, config) {
    const output =
      config.mapping === undefined ? config.input : applyMapping(config.mapping, config.input);
    context.logger.info('Transformed JSON');
    return { status: 'Succeeded', output, logs: context.logger.entries() };
  },
};
