import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateTestDefinition } from '../src/index.js';

type Fixture = Record<string, unknown> & {
  nodes: { type: string; parameters: Record<string, unknown> }[];
};

const fixture = (): Fixture =>
  JSON.parse(
    readFileSync(new URL('../../contracts/fixtures/valid/test.json', import.meta.url), 'utf8'),
  ) as Fixture;

const known = (type: string) => ['delay', 'transform.json', 'assert'].includes(type);

describe('validateTestDefinition', () => {
  it('accepts the contract fixture and returns execution order', () => {
    const result = validateTestDefinition(fixture(), { isKnownStepType: known });
    expect(result).toEqual({
      valid: true,
      issues: [],
      order: ['wait', 'shape-order', 'verify-id'],
    });
  });

  it('reports schema problems first', () => {
    const test = fixture();
    delete (test as Record<string, unknown>).nodes;
    const result = validateTestDefinition(test);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.keyword).toBe('required');
  });

  it('reports graph problems with the flow code as keyword', () => {
    const test = fixture();
    test.edges = [];
    const result = validateTestDefinition(test, { isKnownStepType: known });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.keyword)).toContain('FLOW_MULTIPLE_START');
  });

  it('reports unknown Step types and bad expressions', () => {
    const test = fixture();
    test.nodes[0]!.type = 'blob.upload';
    expect(
      validateTestDefinition(test, { isKnownStepType: known }).issues.map((i) => i.keyword),
    ).toContain('FLOW_UNKNOWN_STEP_TYPE');

    const bad = fixture();
    bad.nodes[1]!.parameters.input = '{{steps.verify-id.output}}';
    const result = validateTestDefinition(bad, { isKnownStepType: known });
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.message).toContain('does not precede');
  });
});
