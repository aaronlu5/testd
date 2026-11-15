import type { TestEdge, TestNode } from '~/api/types'

/**
 * Phase 1 flows are a single sequential chain: one start node, at most one successor and one
 * predecessor per node, no cycles. These helpers mirror the server rules so the editor can refuse
 * invalid edits and explain problems early; the API stays the authority.
 */

export type GraphIssue = { code: string; message: string; nodeIds: string[] }
export type GraphAnalysis = { valid: boolean; issues: GraphIssue[]; order: string[] }

export const MAX_NODES = 200
export const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export const analyzeGraph = (
  nodes: readonly Pick<TestNode, 'id'>[],
  edges: readonly TestEdge[],
): GraphAnalysis => {
  const issues: GraphIssue[] = []
  const add = (code: string, message: string, nodeIds: string[] = []) =>
    issues.push({ code, message, nodeIds })

  if (nodes.length === 0) {
    add('FLOW_EMPTY', 'Add at least one Step.')
    return { valid: false, issues, order: [] }
  }
  const ids = new Set(nodes.map((node) => node.id))
  const next = new Map<string, string[]>([...ids].map((id) => [id, []]))
  const incoming = new Map<string, number>([...ids].map((id) => [id, 0]))
  const seen = new Set<string>()

  for (const edge of edges) {
    const key = `${edge.from}->${edge.to}`
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      add(
        'FLOW_UNKNOWN_EDGE_NODE',
        `Connection ${edge.from} → ${edge.to} refers to a missing Step.`,
      )
    } else if (edge.from === edge.to) {
      add('FLOW_SELF_LOOP', 'A Step cannot connect to itself.', [edge.from])
    } else if (seen.has(key)) {
      add('FLOW_DUPLICATE_EDGE', 'The same connection exists twice.', [edge.from, edge.to])
    } else {
      seen.add(key)
      next.get(edge.from)!.push(edge.to)
      incoming.set(edge.to, incoming.get(edge.to)! + 1)
    }
  }

  for (const [id, targets] of next)
    if (targets.length > 1)
      add('FLOW_FAN_OUT', `"${id}" has several following Steps; Phase 1 runs one after another.`, [
        id,
      ])
  for (const [id, count] of incoming)
    if (count > 1)
      add('FLOW_FAN_IN', `"${id}" has several preceding Steps; Phase 1 runs one after another.`, [
        id,
      ])

  const starts = [...incoming].filter(([, count]) => count === 0).map(([id]) => id)
  if (starts.length > 1)
    add(
      'FLOW_MULTIPLE_START',
      `Steps are not connected into one sequence (${starts.length} separate starts).`,
      starts,
    )

  const order: string[] = []
  const visited = new Set<string>()
  if (starts.length === 1) {
    let current: string | undefined = starts[0]
    while (current !== undefined && !visited.has(current)) {
      visited.add(current)
      order.push(current)
      current = next.get(current)?.[0]
    }
  }
  if (starts.length === 0) {
    add('FLOW_CYCLE', 'The Steps form a loop; loops are not supported.')
  } else if (starts.length === 1 && visited.size < ids.size) {
    add(
      'FLOW_CYCLE',
      'The Steps contain a loop; loops are not supported.',
      [...ids].filter((id) => !visited.has(id)),
    )
  }

  return { valid: issues.length === 0, issues, order: issues.length === 0 ? order : [] }
}

export type ConnectionCheck = { ok: true } | { ok: false; reason: string }

/** Whether adding `from → to` keeps the graph a (possibly still partial) sequential chain. */
export const canConnect = (
  nodes: readonly Pick<TestNode, 'id'>[],
  edges: readonly TestEdge[],
  from: string,
  to: string,
): ConnectionCheck => {
  const known = new Set(nodes.map((node) => node.id))
  if (!known.has(from) || !known.has(to)) return { ok: false, reason: 'Unknown Step.' }
  if (from === to) return { ok: false, reason: 'A Step cannot connect to itself.' }
  if (edges.some((edge) => edge.from === from))
    return {
      ok: false,
      reason: 'This Step already has a following Step; branching is not supported.',
    }
  if (edges.some((edge) => edge.to === to))
    return {
      ok: false,
      reason: 'The target already has a preceding Step; merging is not supported.',
    }
  // A loop forms only if `from` can already be reached by following the chain from `to`.
  const next = new Map(edges.map((edge) => [edge.from, edge.to]))
  let current: string | undefined = to
  for (let hops = 0; current !== undefined && hops <= nodes.length; hops++) {
    if (current === from) return { ok: false, reason: 'That connection would create a loop.' }
    current = next.get(current)
  }
  return { ok: true }
}

export const edgesFromOrder = (order: readonly string[]): TestEdge[] =>
  order.slice(1).map((id, index) => ({ from: order[index] as string, to: id }))

/** Appends a Step; when the flow is a valid chain the new Step is linked after the last one. */
export const addNode = (
  nodes: readonly TestNode[],
  edges: readonly TestEdge[],
  node: TestNode,
): { nodes: TestNode[]; edges: TestEdge[] } => {
  const analysis = analyzeGraph(nodes, edges)
  const tail = analysis.valid ? analysis.order[analysis.order.length - 1] : undefined
  return {
    nodes: [...nodes, node],
    edges: tail ? [...edges, { from: tail, to: node.id }] : [...edges],
  }
}

/** Removes a Step and its connections, bridging its neighbours so the sequence stays whole. */
export const removeNode = (
  nodes: readonly TestNode[],
  edges: readonly TestEdge[],
  id: string,
): { nodes: TestNode[]; edges: TestEdge[] } => {
  const before = edges.find((edge) => edge.to === id)?.from
  const after = edges.find((edge) => edge.from === id)?.to
  const kept = edges.filter((edge) => edge.from !== id && edge.to !== id)
  if (before && after) kept.push({ from: before, to: after })
  return { nodes: nodes.filter((node) => node.id !== id), edges: kept }
}

/** Moves a Step by `delta` positions; only possible while the flow is one valid chain. */
export const moveNode = (
  nodes: readonly Pick<TestNode, 'id'>[],
  edges: readonly TestEdge[],
  id: string,
  delta: -1 | 1,
): TestEdge[] | undefined => {
  const analysis = analyzeGraph(nodes, edges)
  if (!analysis.valid) return undefined
  const order = [...analysis.order]
  const index = order.indexOf(id)
  const target = index + delta
  if (index < 0 || target < 0 || target >= order.length) return undefined
  const moved = order[index] as string
  order[index] = order[target] as string
  order[target] = moved
  return edgesFromOrder(order)
}

/** An id not used yet, derived from the Step type (`transform.json` becomes `transform-json`). */
export const uniqueNodeId = (nodes: readonly Pick<TestNode, 'id'>[], type: string): string => {
  const base = type.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'step'
  const used = new Set(nodes.map((node) => node.id))
  if (!used.has(base)) return base.slice(0, 64)
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!used.has(candidate)) return candidate.slice(0, 64)
  }
}

/** Display order: the chain first, then any Steps that are not connected yet. */
export const displayOrder = (
  nodes: readonly Pick<TestNode, 'id'>[],
  edges: readonly TestEdge[],
): string[] => {
  const ids = nodes.map((node) => node.id)
  const next = new Map(edges.map((edge) => [edge.from, edge.to]))
  const hasPredecessor = new Set(edges.map((edge) => edge.to))
  const seen = new Set<string>()
  const chains: string[][] = []
  for (const start of ids.filter((id) => !hasPredecessor.has(id))) {
    const chain: string[] = []
    let current: string | undefined = start
    while (current !== undefined && !seen.has(current)) {
      seen.add(current)
      chain.push(current)
      current = next.get(current)
    }
    chains.push(chain)
  }
  // Longer chains first, so loose Steps that are not connected yet sit below the main sequence.
  chains.sort((a, b) => b.length - a.length)
  return [...chains.flat(), ...ids.filter((id) => !seen.has(id))]
}

export const layoutPositions = (
  nodes: readonly Pick<TestNode, 'id'>[],
  edges: readonly TestEdge[],
  step = 170,
): Record<string, { x: number; y: number }> =>
  Object.fromEntries(displayOrder(nodes, edges).map((id, index) => [id, { x: 0, y: index * step }]))
