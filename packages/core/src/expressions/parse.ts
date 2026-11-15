import { PlatformError } from '../errors.js';

export const EXPRESSION_ROOTS = [
  'testData',
  'variables',
  'environment',
  'steps',
  'global',
] as const;
export type ExpressionRoot = (typeof EXPRESSION_ROOTS)[number];

export type Reference = {
  root: ExpressionRoot;
  /** Path after the root. For `steps` it is `[nodeId, 'output', ...rest]`. */
  path: string[];
  raw: string;
};

export type TemplateSegment =
  { kind: 'text'; text: string } | { kind: 'expression'; reference: Reference };

export type ParsedTemplate = {
  segments: TemplateSegment[];
  /** True when the whole string is one expression, so the native JSON type is preserved. */
  isSingleExpression: boolean;
};

export class ExpressionError extends PlatformError {
  constructor(message: string, detail?: string) {
    super('VALIDATION_EXPRESSION', message, { detail });
    this.name = 'ExpressionError';
  }
}

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_-]*/;
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_EXPRESSION_LENGTH = 256;

const parseReference = (raw: string): Reference => {
  const text = raw.trim();
  if (text.length === 0) throw new ExpressionError('Empty expression "{{ }}".');
  if (text.length > MAX_EXPRESSION_LENGTH)
    throw new ExpressionError('Expression is too long.', text.slice(0, 40));

  const tokens: string[] = [];
  let position = 0;
  while (position < text.length) {
    const rest = text.slice(position);
    if (tokens.length > 0) {
      if (rest.startsWith('.')) {
        position += 1;
      } else if (rest.startsWith('[')) {
        const close = rest.indexOf(']');
        const index = close === -1 ? '' : rest.slice(1, close);
        if (!/^\d+$/.test(index))
          throw new ExpressionError(`Invalid index in expression "${text}".`);
        tokens.push(index);
        position += close + 1;
        continue;
      } else {
        throw new ExpressionError(`Unexpected character "${rest[0]}" in expression "${text}".`);
      }
    }
    const match = SEGMENT.exec(text.slice(position));
    if (!match) throw new ExpressionError(`Invalid path in expression "${text}".`);
    tokens.push(match[0]);
    position += match[0].length;
  }

  const [root, ...path] = tokens as [string, ...string[]];
  if (!(EXPRESSION_ROOTS as readonly string[]).includes(root)) {
    throw new ExpressionError(
      `Unknown expression root "${root}"; allowed roots are ${EXPRESSION_ROOTS.join(', ')}.`,
    );
  }
  if (path.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) {
    throw new ExpressionError(`Expression "${text}" uses a forbidden path segment.`);
  }
  if (root === 'steps' && (path.length < 2 || path[1] !== 'output')) {
    throw new ExpressionError(
      `Step references must have the form steps.<nodeId>.output (got "${text}").`,
    );
  }
  return { root: root as ExpressionRoot, path, raw: text };
};

export const parseTemplate = (source: string): ParsedTemplate => {
  const segments: TemplateSegment[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf('{{', cursor);
    if (open === -1) {
      segments.push({ kind: 'text', text: source.slice(cursor) });
      break;
    }
    if (open > cursor) segments.push({ kind: 'text', text: source.slice(cursor, open) });
    const close = source.indexOf('}}', open + 2);
    if (close === -1)
      throw new ExpressionError('Unclosed "{{" in expression.', source.slice(open, open + 40));
    segments.push({ kind: 'expression', reference: parseReference(source.slice(open + 2, close)) });
    cursor = close + 2;
  }
  const isSingleExpression = segments.length === 1 && segments[0]?.kind === 'expression';
  return { segments, isSingleExpression };
};

export const containsExpression = (source: string): boolean => source.includes('{{');
