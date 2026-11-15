import { describe, expect, it } from 'vitest';
import { validateFlow, type FlowIssueCode } from '../src/index.js';

const nodes = (...ids: string[]) => ids.map((id) => ({ id, type: 'delay' }));
const chain = (...ids: string[]) =>
  ids.slice(1).map((to, index) => ({ from: ids[index] as string, to }));
const codes = (result: ReturnType<typeof validateFlow>): FlowIssueCode[] =>
  result.issues.map((issue) => issue.code);

describe('validateFlow', () => {
  it('accepts a sequential chain and returns the execution order', () => {
    const result = validateFlow({ nodes: nodes('c', 'a', 'b'), edges: chain('a', 'b', 'c') });
    expect(result).toMatchObject({ valid: true, order: ['a', 'b', 'c'], issues: [] });
  });

  it('accepts a single node with no edges', () => {
    expect(validateFlow({ nodes: nodes('only'), edges: [] })).toMatchObject({
      valid: true,
      order: ['only'],
    });
  });

  it('rejects an empty flow', () => {
    expect(codes(validateFlow({ nodes: [], edges: [] }))).toEqual(['FLOW_EMPTY']);
  });

  it('rejects multiple start nodes', () => {
    const result = validateFlow({ nodes: nodes('a', 'b', 'c'), edges: [{ from: 'a', to: 'c' }] });
    expect(codes(result)).toContain('FLOW_MULTIPLE_START');
    expect(result.valid).toBe(false);
  });

  it('rejects fan-out and fan-in', () => {
    const fanOut = validateFlow({
      nodes: nodes('a', 'b', 'c'),
      edges: [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
      ],
    });
    expect(codes(fanOut)).toContain('FLOW_FAN_OUT');
    const fanIn = validateFlow({
      nodes: nodes('a', 'b', 'c'),
      edges: [
        { from: 'a', to: 'c' },
        { from: 'b', to: 'c' },
      ],
    });
    expect(codes(fanIn)).toEqual(expect.arrayContaining(['FLOW_FAN_IN', 'FLOW_MULTIPLE_START']));
  });

  it('rejects a cycle with no start node', () => {
    const result = validateFlow({ nodes: nodes('a', 'b'), edges: chain('a', 'b', 'a') });
    expect(codes(result)).toEqual(['FLOW_CYCLE']);
    expect(result.issues[0]?.nodeIds.sort()).toEqual(['a', 'b']);
  });

  it('rejects a cycle that is disconnected from a valid chain', () => {
    const result = validateFlow({
      nodes: nodes('a', 'b', 'x', 'y'),
      edges: [...chain('a', 'b'), ...chain('x', 'y', 'x')],
    });
    expect(codes(result)).toContain('FLOW_CYCLE');
    expect(result.valid).toBe(false);
  });

  it('rejects self loops and duplicate edges', () => {
    expect(codes(validateFlow({ nodes: nodes('a'), edges: [{ from: 'a', to: 'a' }] }))).toContain(
      'FLOW_SELF_LOOP',
    );
    const duplicate = validateFlow({
      nodes: nodes('a', 'b'),
      edges: [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'b' },
      ],
    });
    expect(codes(duplicate)).toContain('FLOW_DUPLICATE_EDGE');
  });

  it('reports nodes that are not on the single path from the start node', () => {
    const result = validateFlow({
      nodes: nodes('a', 'b', 'c'),
      edges: [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
      ],
    });
    expect(codes(result)).toEqual(expect.arrayContaining(['FLOW_FAN_OUT', 'FLOW_DISCONNECTED']));
    expect(result.issues.find((issue) => issue.code === 'FLOW_DISCONNECTED')?.nodeIds).toEqual([
      'c',
    ]);
  });

  it('rejects duplicate ids and edges to unknown nodes', () => {
    expect(codes(validateFlow({ nodes: nodes('a', 'a'), edges: [] }))).toContain(
      'FLOW_DUPLICATE_NODE',
    );
    const unknown = validateFlow({ nodes: nodes('a'), edges: [{ from: 'a', to: 'ghost' }] });
    expect(codes(unknown)).toContain('FLOW_UNKNOWN_EDGE_NODE');
  });

  it('validates Step type references when a registry predicate is supplied', () => {
    const result = validateFlow(
      { nodes: [{ id: 'a', type: 'nope' }], edges: [] },
      { isKnownStepType: (type) => type === 'delay' },
    );
    expect(codes(result)).toEqual(['FLOW_UNKNOWN_STEP_TYPE']);
  });
});
