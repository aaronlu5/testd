import type { TestEdge, TestNode } from '@test-platform/contracts';

export type FlowIssueCode =
  | 'FLOW_EMPTY'
  | 'FLOW_DUPLICATE_NODE'
  | 'FLOW_UNKNOWN_EDGE_NODE'
  | 'FLOW_SELF_LOOP'
  | 'FLOW_DUPLICATE_EDGE'
  | 'FLOW_FAN_OUT'
  | 'FLOW_FAN_IN'
  | 'FLOW_NO_START'
  | 'FLOW_MULTIPLE_START'
  | 'FLOW_CYCLE'
  | 'FLOW_DISCONNECTED'
  | 'FLOW_UNKNOWN_STEP_TYPE'
  | 'FLOW_POSITION_INVALID'
  | 'FLOW_EDGES_MISMATCH';

export type FlowIssue = { code: FlowIssueCode; message: string; nodeIds: string[] };

export type FlowValidationResult = {
  valid: boolean;
  issues: FlowIssue[];
  /** Execution order from the start node; empty unless the flow is valid. */
  order: string[];
};

export type FlowValidationOptions = {
  isKnownStepType?: (type: string) => boolean;
};

/** Validates the Phase 1 sequential-flow restrictions. */
export const validateFlow = (
  flow: { nodes: Pick<TestNode, 'id' | 'type'>[]; edges: TestEdge[] },
  options: FlowValidationOptions = {},
): FlowValidationResult => {
  const issues: FlowIssue[] = [];
  const add = (code: FlowIssueCode, message: string, nodeIds: string[] = []): void => {
    issues.push({ code, message, nodeIds });
  };

  if (flow.nodes.length === 0) {
    add('FLOW_EMPTY', 'A Test must contain at least one Step.');
    return { valid: false, issues, order: [] };
  }

  const nodeIds = new Set<string>();
  for (const node of flow.nodes) {
    if (nodeIds.has(node.id))
      add('FLOW_DUPLICATE_NODE', `Node id "${node.id}" is used more than once.`, [node.id]);
    nodeIds.add(node.id);
    if (options.isKnownStepType && !options.isKnownStepType(node.type)) {
      add('FLOW_UNKNOWN_STEP_TYPE', `Node "${node.id}" uses unknown Step type "${node.type}".`, [
        node.id,
      ]);
    }
  }

  const successors = new Map<string, string[]>();
  const incoming = new Map<string, number>();
  for (const id of nodeIds) {
    successors.set(id, []);
    incoming.set(id, 0);
  }

  const seenEdges = new Set<string>();
  for (const edge of flow.edges) {
    const unknown = [edge.from, edge.to].filter((id) => !nodeIds.has(id));
    if (unknown.length > 0) {
      add(
        'FLOW_UNKNOWN_EDGE_NODE',
        `Edge ${edge.from} -> ${edge.to} references unknown node(s): ${unknown.join(', ')}.`,
        unknown,
      );
      continue;
    }
    if (edge.from === edge.to) {
      add('FLOW_SELF_LOOP', `Node "${edge.from}" has an edge to itself.`, [edge.from]);
      continue;
    }
    const key = `${edge.from}\u0000${edge.to}`;
    if (seenEdges.has(key)) {
      add('FLOW_DUPLICATE_EDGE', `Edge ${edge.from} -> ${edge.to} is declared more than once.`, [
        edge.from,
        edge.to,
      ]);
      continue;
    }
    seenEdges.add(key);
    successors.get(edge.from)!.push(edge.to);
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }

  for (const [id, next] of successors) {
    if (next.length > 1)
      add('FLOW_FAN_OUT', `Node "${id}" has ${next.length} successors; only one is allowed.`, [
        id,
        ...next,
      ]);
  }
  for (const [id, count] of incoming) {
    if (count > 1)
      add('FLOW_FAN_IN', `Node "${id}" has ${count} predecessors; only one is allowed.`, [id]);
  }

  // Kahn's algorithm: nodes left over belong to, or hang off, a cycle.
  const remainingIncoming = new Map(incoming);
  const queue = [...remainingIncoming].filter(([, count]) => count === 0).map(([id]) => id);
  let processed = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    processed += 1;
    for (const next of successors.get(id) ?? []) {
      const left = (remainingIncoming.get(next) ?? 0) - 1;
      remainingIncoming.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  const cyclic = new Set<string>();
  if (processed < nodeIds.size) {
    for (const [id, count] of remainingIncoming) if (count > 0) cyclic.add(id);
    add('FLOW_CYCLE', `The flow contains a cycle involving: ${[...cyclic].join(', ')}.`, [
      ...cyclic,
    ]);
  }

  const starts = [...incoming].filter(([, count]) => count === 0).map(([id]) => id);
  if (starts.length === 0 && cyclic.size === 0) add('FLOW_NO_START', 'The flow has no start node.');
  if (starts.length > 1)
    add(
      'FLOW_MULTIPLE_START',
      `The flow has ${starts.length} start nodes: ${starts.join(', ')}.`,
      starts,
    );

  const order: string[] = [];
  if (starts.length === 1) {
    const visited = new Set<string>();
    let current: string | undefined = starts[0];
    while (current !== undefined && !visited.has(current)) {
      visited.add(current);
      order.push(current);
      current = successors.get(current)?.[0];
    }
    const disconnected = [...nodeIds].filter((id) => !visited.has(id) && !cyclic.has(id));
    if (disconnected.length > 0) {
      add(
        'FLOW_DISCONNECTED',
        `Node(s) not reachable from the start node: ${disconnected.join(', ')}.`,
        disconnected,
      );
    }
  }

  return { valid: issues.length === 0, issues, order: issues.length === 0 ? order : [] };
};
