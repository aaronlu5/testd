import { describe, expect, it } from 'vitest';
import type { TestNode } from '@test-platform/contracts';
import {
  ExpressionError,
  parseTemplate,
  resolveTemplate,
  resolveValue,
  resolveVariables,
  validateExpressions,
  type ExpressionContext,
} from '../src/index.js';

const context: ExpressionContext = {
  testData: {
    order: {
      id: 'ORD-1',
      lines: [{ sku: 'A' }, { sku: 'B' }],
      total: 12.5,
      paid: true,
      note: null,
    },
  },
  variables: { orderId: 'ORD-1' },
  environment: { region: 'eu' },
  steps: { 'upload-order': { output: { etag: 'abc', size: 3 } } },
};

describe('parseTemplate', () => {
  it('parses literals and expressions', () => {
    const parsed = parseTemplate('orders/{{ variables.orderId }}.json');
    expect(parsed.isSingleExpression).toBe(false);
    expect(parsed.segments).toHaveLength(3);
  });

  it.each([
    ['{{', 'Unclosed'],
    ['{{ }}', 'Empty'],
    ['{{ process.env.HOME }}', 'Unknown expression root'],
    ['{{ testData.a b }}', 'Unexpected character'],
    ['{{ testData..a }}', 'Invalid path'],
    ['{{ testData[x] }}', 'Invalid index'],
    ['{{ testData.__proto__.x }}', 'forbidden'],
    ['{{ steps.a }}', 'steps.<nodeId>.output'],
    ['{{ steps.a.result }}', 'steps.<nodeId>.output'],
    ['{{ 1 + 1 }}', 'Unexpected character'],
    ['{{ testData.fn() }}', 'Unexpected character'],
  ])('rejects %s', (source, message) => {
    expect(() => parseTemplate(source)).toThrow(ExpressionError);
    expect(() => parseTemplate(source)).toThrow(message);
  });
});

describe('resolveTemplate', () => {
  it('preserves native types for whole-value expressions', () => {
    expect(resolveTemplate('{{testData.order.total}}', context)).toBe(12.5);
    expect(resolveTemplate('{{ testData.order.paid }}', context)).toBe(true);
    expect(resolveTemplate('{{testData.order.note}}', context)).toBeNull();
    expect(resolveTemplate('{{testData.order.lines}}', context)).toEqual([
      { sku: 'A' },
      { sku: 'B' },
    ]);
  });

  it('interpolates into strings otherwise', () => {
    expect(
      resolveTemplate('id={{testData.order.id}} total={{testData.order.total}}', context),
    ).toBe('id=ORD-1 total=12.5');
    expect(resolveTemplate(' {{variables.orderId}} ', context)).toBe(' ORD-1 ');
    expect(resolveTemplate('line {{testData.order.lines[1].sku}}', context)).toBe('line B');
    expect(resolveTemplate('{{testData.order.lines.0}}!', context)).toBe('{"sku":"A"}!');
  });

  it('resolves environment and preceding step output', () => {
    expect(resolveTemplate('{{environment.region}}', context)).toBe('eu');
    expect(resolveTemplate('{{steps.upload-order.output.etag}}', context)).toBe('abc');
  });

  it.each([
    '{{testData.missing}}',
    '{{testData.order.lines[5]}}',
    '{{steps.later.output.x}}',
    '{{variables.nope}}',
    '{{environment.secretKey}}',
    '{{testData.order.id.length}}',
    '{{testData.order.toString}}',
  ])('fails on missing reference %s', (source) => {
    expect(() => resolveTemplate(source, context)).toThrow(ExpressionError);
  });

  it('does not reach inherited properties', () => {
    expect(() => resolveTemplate('{{testData.order.hasOwnProperty}}', context)).toThrow(
      ExpressionError,
    );
  });
});

describe('resolveValue', () => {
  it('resolves recursively without touching keys or non-strings', () => {
    const resolved = resolveValue(
      { '{{key}}': 1, a: ['{{variables.orderId}}', 2, null], b: { c: '{{testData.order.paid}}' } },
      context,
    );
    expect(resolved).toEqual({ '{{key}}': 1, a: ['ORD-1', 2, null], b: { c: true } });
  });
});

describe('resolveVariables', () => {
  const base = { testData: context.testData, environment: context.environment };

  it('resolves dependent variables regardless of declaration order', () => {
    const result = resolveVariables(
      { path: 'orders/{{variables.id}}', id: '{{testData.order.id}}' },
      base,
    );
    expect(result).toEqual({ id: 'ORD-1', path: 'orders/ORD-1' });
  });

  it('applies overrides to declared variables only', () => {
    expect(resolveVariables({ id: 'a' }, base, { id: 'b' })).toEqual({ id: 'b' });
    expect(() => resolveVariables({ id: 'a' }, base, { other: 'b' })).toThrow(
      'does not match a declared variable',
    );
  });

  it('detects circular references', () => {
    expect(() => resolveVariables({ a: '{{variables.b}}', b: '{{variables.a}}' }, base)).toThrow(
      /Circular variable reference: a -> b -> a/,
    );
    expect(() => resolveVariables({ a: '{{variables.a}}' }, base)).toThrow(/Circular/);
  });

  it('rejects references to undeclared variables and step outputs', () => {
    expect(() => resolveVariables({ a: '{{variables.zzz}}' }, base)).toThrow(ExpressionError);
    expect(() => resolveVariables({ a: '{{steps.x.output}}' }, base)).toThrow(ExpressionError);
  });
});

describe('validateExpressions', () => {
  const nodes: TestNode[] = [
    { id: 'first', type: 'delay', name: 'First', parameters: { note: '{{variables.v}}' } },
    {
      id: 'second',
      type: 'assert',
      name: 'Second',
      parameters: { actual: '{{steps.first.output.x}}' },
    },
  ];

  it('accepts references to declared variables and preceding steps', () => {
    expect(
      validateExpressions({ variables: { v: '1' }, nodes }, { order: ['first', 'second'] }),
    ).toEqual([]);
  });

  it('flags later, self, and unknown step references', () => {
    const reversed = validateExpressions(
      { variables: { v: '1' }, nodes },
      { order: ['second', 'first'] },
    );
    expect(reversed.map((issue) => issue.message)).toEqual([
      expect.stringContaining('does not precede'),
    ]);

    const self = validateExpressions(
      {
        variables: {},
        nodes: [{ id: 'a', type: 'delay', name: 'A', parameters: { x: '{{steps.a.output}}' } }],
      },
      { order: ['a'] },
    );
    expect(self[0]?.message).toContain('does not precede');

    const unknown = validateExpressions(
      {
        variables: {},
        nodes: [{ id: 'a', type: 'delay', name: 'A', parameters: { x: '{{steps.ghost.output}}' } }],
      },
      { order: ['a'] },
    );
    expect(unknown[0]?.message).toContain('does not exist');
  });

  it('reports syntax errors, undeclared variables, step refs in variables, and cycles with paths', () => {
    const issues = validateExpressions(
      {
        variables: {
          a: '{{variables.b}}',
          b: '{{variables.a}}',
          c: '{{steps.first.output}}',
          d: '{{oops}}',
        },
        nodes: [
          { id: 'first', type: 'delay', name: 'F', parameters: { x: '{{variables.missing}}' } },
        ],
      },
      { order: ['first'] },
    );
    const messages = issues.map((issue) => issue.message).join('\n');
    expect(messages).toContain('Circular');
    expect(messages).toContain('cannot reference step outputs');
    expect(messages).toContain('Unknown expression root');
    expect(messages).toContain('"missing" is not declared');
    expect(issues.find((issue) => issue.message.includes('"missing"'))?.path).toBe(
      '/nodes/0/parameters/x',
    );
  });

  it('checks environment keys when provided', () => {
    const node = [
      { id: 'a', type: 'delay', name: 'A', parameters: { x: '{{environment.region}}' } },
    ];
    expect(
      validateExpressions(
        { variables: {}, nodes: node },
        { order: ['a'], environmentKeys: ['region'] },
      ),
    ).toEqual([]);
    expect(
      validateExpressions({ variables: {}, nodes: node }, { order: ['a'], environmentKeys: [] }),
    ).toHaveLength(1);
  });
});
