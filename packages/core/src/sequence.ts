import type { NodePosition, TestDefinition, TestEdge } from '@test-platform/contracts';
import { validateFlow, type FlowIssue } from './flow.js';

type Positioned = { id: string; position?: NodePosition };

/** True when execution order is derived from node positions rather than hand-authored edges. */
export const isPositionManaged = (test: Pick<TestDefinition, 'editor'>): boolean =>
  test.editor?.autoSequenceFromPosition === true;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export const hasValidPosition = (node: Positioned): boolean =>
  node.position !== undefined && isFiniteNumber(node.position.x) && isFiniteNumber(node.position.y);

/** Code-unit comparison so ordering never depends on the host locale. */
const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Vertical ordering: `y`, then `x`, then node id as a stable tie-breaker. Nodes without a valid
 * position are not sortable; callers must check `hasValidPosition` first.
 */
export const comparePositioned = (a: Positioned, b: Positioned): number => {
  const ay = a.position?.y ?? 0;
  const by = b.position?.y ?? 0;
  if (ay !== by) return ay < by ? -1 : 1;
  const ax = a.position?.x ?? 0;
  const bx = b.position?.x ?? 0;
  if (ax !== bx) return ax < bx ? -1 : 1;
  return compareIds(a.id, b.id);
};

/** Node ids in execution order, derived purely from positions. */
export const sortNodesByPosition = (nodes: readonly Positioned[]): string[] =>
  [...nodes].sort(comparePositioned).map((node) => node.id);

/** One system-managed edge between each adjacent pair of `order`. */
export const generateSequentialEdges = (order: readonly string[]): TestEdge[] =>
  order.slice(1).map((to, index) => ({
    from: order[index] as string,
    to,
    metadata: { systemManaged: true },
  }));

const edgeKey = (edge: Pick<TestEdge, 'from' | 'to'>): string => `${edge.from}\u0000${edge.to}`;

export const sameEdgeSet = (
  a: readonly Pick<TestEdge, 'from' | 'to'>[],
  b: readonly Pick<TestEdge, 'from' | 'to'>[],
): boolean => {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map(edgeKey));
  return keys.size === a.length && b.every((edge) => keys.has(edgeKey(edge)));
};

/** Position problems and edges that disagree with positions, for position-managed Tests. */
export const validatePositionSequence = (
  test: Pick<TestDefinition, 'editor' | 'nodes' | 'edges'>,
): FlowIssue[] => {
  if (!isPositionManaged(test)) return [];
  const invalid = test.nodes.filter((node) => !hasValidPosition(node)).map((node) => node.id);
  if (invalid.length > 0) {
    return [
      {
        code: 'FLOW_POSITION_INVALID',
        message: `Node(s) need a numeric position when sequencing from position is enabled: ${invalid.join(', ')}.`,
        nodeIds: invalid,
      },
    ];
  }
  const ids = new Set(test.nodes.map((node) => node.id));
  if (ids.size !== test.nodes.length) return []; // duplicate ids are reported by validateFlow
  const expected = generateSequentialEdges(sortNodesByPosition(test.nodes));
  if (sameEdgeSet(expected, test.edges)) return [];
  return [
    {
      code: 'FLOW_EDGES_MISMATCH',
      message: "The edges do not match the order of the nodes' positions.",
      nodeIds: [],
    },
  ];
};

export type LayoutNormalization = {
  test: TestDefinition;
  /** Execution order after normalization; empty when the layout is invalid. */
  order: string[];
  /** The edge list differs from the one supplied. */
  edgesChanged: boolean;
  /** The execution order differs from the one the supplied edges described. */
  orderChanged: boolean;
  issues: FlowIssue[];
};

/**
 * Server-side normalization: for position-managed Tests the edge list is replaced by the edges
 * generated from node positions. Legacy Tests (sequencing disabled) keep their stored edges and
 * are returned unchanged. The input is never mutated.
 */
export const normalizeTestLayout = (test: TestDefinition): LayoutNormalization => {
  const previous = validateFlow(test);
  if (!isPositionManaged(test)) {
    return {
      test,
      order: previous.order,
      edgesChanged: false,
      orderChanged: false,
      issues: [],
    };
  }

  const invalid = test.nodes.filter((node) => !hasValidPosition(node)).map((node) => node.id);
  if (invalid.length > 0) {
    return {
      test,
      order: [],
      edgesChanged: false,
      orderChanged: false,
      issues: validatePositionSequence(test),
    };
  }

  const order = sortNodesByPosition(test.nodes);
  const edges = generateSequentialEdges(order);
  const edgesChanged =
    !sameEdgeSet(edges, test.edges) || test.edges.some((e) => !e.metadata?.systemManaged);
  const orderChanged =
    !previous.valid ||
    previous.order.length !== order.length ||
    previous.order.some((id, index) => id !== order[index]);
  return { test: { ...test, edges }, order, edgesChanged, orderChanged, issues: [] };
};

/**
 * Human-readable summary of a reorder, suitable for an accessible announcement, for example
 * `"Verify status moved from position 3 to position 2; connections updated."`
 */
export const describeReorder = (
  before: readonly string[],
  after: readonly string[],
  nameOf: (id: string) => string = (id) => id,
): string[] =>
  after.flatMap((id, index) => {
    const from = before.indexOf(id);
    return from >= 0 && from !== index
      ? [
          `${nameOf(id)} moved from position ${from + 1} to position ${index + 1}; connections updated.`,
        ]
      : [];
  });
