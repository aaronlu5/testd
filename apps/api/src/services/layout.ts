import { describeReorder, normalizeTestLayout, validateFlow } from '@test-platform/core';
import type { TestDefinition } from '@test-platform/contracts';

/** What the server changed when it derived a Test's order and edges from node positions. */
export type NormalizationReport = {
  autoSequenceFromPosition: true;
  /** The edge list differs from the one the client sent. */
  edgesChanged: boolean;
  /** The execution order differs from the one the client's edges described. */
  orderChanged: boolean;
  previousOrder: string[];
  order: string[];
  /** Accessible, human-readable description of each node that moved. */
  moves: string[];
};

export type ApiWarning = { code: 'FLOW_ORDER_CHANGED'; message: string };

export type Normalized = {
  candidate: unknown;
  normalization?: NormalizationReport;
  warnings: ApiWarning[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const looksLikeFlow = (value: Record<string, unknown>): boolean =>
  Array.isArray(value.nodes) &&
  Array.isArray(value.edges) &&
  value.nodes.every((node) => isRecord(node) && typeof node.id === 'string');

/**
 * Server-side sequencing for position-managed Tests: the edge list is replaced by the one derived
 * from node positions, whatever the client sent. Anything else (legacy Tests, drafts that are not
 * yet well-formed) is returned unchanged for the normal validation to judge. A warning is raised
 * only when the client had a valid order and the server changed it.
 */
export const normalizeCandidate = (candidate: unknown): Normalized => {
  if (!isRecord(candidate) || !looksLikeFlow(candidate)) return { candidate, warnings: [] };
  const editor = candidate.editor;
  if (!isRecord(editor) || editor.autoSequenceFromPosition !== true)
    return { candidate, warnings: [] };

  const test = candidate as unknown as TestDefinition;
  const result = normalizeTestLayout(test);
  // Missing or non-numeric positions are reported by validation, not repaired here.
  if (result.issues.length > 0) return { candidate, warnings: [] };

  const previousOrder = validateFlow({ nodes: test.nodes, edges: test.edges }).order;
  const names = new Map(test.nodes.map((node) => [node.id, node.name]));
  const moves =
    previousOrder.length > 0
      ? describeReorder(previousOrder, result.order, (id) => names.get(id) ?? id)
      : [];
  const warnings: ApiWarning[] =
    previousOrder.length > 0 && result.orderChanged
      ? [
          {
            code: 'FLOW_ORDER_CHANGED',
            message:
              'The order of Steps was recalculated from their positions and the connections were regenerated.',
          },
        ]
      : [];
  return {
    candidate: { ...candidate, edges: result.test.edges },
    normalization: {
      autoSequenceFromPosition: true,
      edgesChanged: result.edgesChanged,
      orderChanged: result.orderChanged && previousOrder.length > 0,
      previousOrder,
      order: result.order,
      moves,
    },
    warnings,
  };
};
