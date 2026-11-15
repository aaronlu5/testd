import type { TestEdge, TestNode } from '~/api/types'

/**
 * Position-driven sequencing for the vertical canvas. These pure functions mirror the server rules
 * (order by `y`, then `x`, then node id; one system-managed edge between each adjacent pair) so the
 * editor can preview a drag instantly. The server re-derives everything on save and its answer is
 * authoritative.
 */

export type Point = { x: number; y: number }
type Positioned = Pick<TestNode, 'id'> & { position?: Point }

/** Vertical distance between Steps when the editor lays a sequence out. */
export const STEP_SPACING = 200
/** Approximate rendered size of a Step card, used until Vue Flow reports real dimensions. */
export const NODE_WIDTH = 192
export const NODE_HEIGHT = 116
/**
 * Closest two neighbouring Steps may sit before the layout counts as cramped: the cards then
 * leave too little room for the connection dots and the line between them.
 */
export const MIN_STEP_GAP = NODE_HEIGHT + 48
/** Pixels past a neighbour's vertical midpoint a dragged Step must travel before it swaps places. */
export const DEFAULT_REORDER_THRESHOLD = 12

/** Code-unit comparison, independent of the browser locale, like the server. */
const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export const comparePositioned = (a: Positioned, b: Positioned): number => {
  const ay = a.position?.y ?? 0
  const by = b.position?.y ?? 0
  if (ay !== by) return ay < by ? -1 : 1
  const ax = a.position?.x ?? 0
  const bx = b.position?.x ?? 0
  if (ax !== bx) return ax < bx ? -1 : 1
  return compareIds(a.id, b.id)
}

export const hasPosition = (node: Positioned): boolean =>
  node.position !== undefined &&
  Number.isFinite(node.position.x) &&
  Number.isFinite(node.position.y)

/** Node ids in execution order, derived only from positions. */
export const sortByPosition = (nodes: readonly Positioned[]): string[] =>
  [...nodes].sort(comparePositioned).map((node) => node.id)

export const systemEdges = (order: readonly string[]): TestEdge[] =>
  order.slice(1).map((to, index) => ({
    from: order[index] as string,
    to,
    metadata: { systemManaged: true },
  }))

/** Positions for `order`: a single vertical stack, keeping each Step's current x. */
export const stackPositions = (
  order: readonly string[],
  xOf: (id: string) => number = () => 0,
): Record<string, Point> =>
  Object.fromEntries(order.map((id, index) => [id, { x: xOf(id), y: index * STEP_SPACING }]))

/**
 * A readable layout for a sequence that was saved with its Steps too close together (older Tests
 * used a tighter spacing than the cards need), or `undefined` when the layout is fine. The order is
 * unchanged, so the execution sequence is never affected.
 */
export const relaxedPositions = (
  nodes: readonly Positioned[],
): Record<string, Point> | undefined => {
  if (nodes.length < 2 || !nodes.every((node) => node.position)) return undefined
  const order = sortByPosition(nodes)
  const yOf = (id: string): number => nodes.find((node) => node.id === id)?.position?.y ?? 0
  const cramped = order.some(
    (id, index) => index > 0 && yOf(id) - yOf(order[index - 1] as string) < MIN_STEP_GAP,
  )
  if (!cramped) return undefined
  return stackPositions(order, (id) => nodes.find((node) => node.id === id)?.position?.x ?? 0)
}

export type DropResult = {
  /** Execution order after the drop. */
  order: string[]
  /** Where the dragged Step ended up in `order` (zero-based). */
  index: number
  /** True when the dragged Step changed place relative to its neighbours. */
  moved: boolean
}

type DropOptions = { nodeHeight?: number; threshold?: number }

/**
 * Decides where a dragged Step lands. It starts from its current place and passes a neighbour
 * only when its centre has crossed that neighbour's vertical midpoint by more than `threshold`, so
 * nudging a card while tidying a layout never reorders the sequence by accident.
 */
export const resolveDrop = (
  nodes: readonly Positioned[],
  draggedId: string,
  draggedY: number,
  options: DropOptions = {},
): DropResult => {
  const threshold = options.threshold ?? DEFAULT_REORDER_THRESHOLD
  const height = options.nodeHeight ?? NODE_HEIGHT
  const order = sortByPosition(nodes)
  const start = order.indexOf(draggedId)
  if (start < 0) return { order, index: -1, moved: false }

  const centre = (id: string): number =>
    (nodes.find((node) => node.id === id)?.position?.y ?? 0) + height / 2
  const draggedCentre = draggedY + height / 2

  const others = order.filter((id) => id !== draggedId)
  let index = start
  while (index < others.length && draggedCentre > centre(others[index] as string) + threshold) {
    index += 1
  }
  while (index > 0 && draggedCentre < centre(others[index - 1] as string) - threshold) {
    index -= 1
  }
  const next = [...others.slice(0, index), draggedId, ...others.slice(index)]
  return { order: next, index, moved: index !== start }
}

/** Where the insertion marker belongs while dragging: the gap `index` in the order without the dragged Step. */
export const insertionY = (
  nodes: readonly Positioned[],
  order: readonly string[],
  draggedId: string,
  nodeHeight: number = NODE_HEIGHT,
): number => {
  const rest = order.filter((id) => id !== draggedId)
  const index = order.indexOf(draggedId)
  const yOf = (id: string): number => nodes.find((n) => n.id === id)?.position?.y ?? 0
  const before = index > 0 ? rest[index - 1] : undefined
  const after = rest[index]
  if (before !== undefined && after !== undefined)
    return (yOf(before) + nodeHeight + yOf(after)) / 2
  if (before !== undefined) return yOf(before) + nodeHeight + 12
  if (after !== undefined) return yOf(after) - 12
  return 0
}

export type SequenceUpdate = {
  nodes: TestNode[]
  edges: TestEdge[]
  order: string[]
  /** Whether the execution order changed. */
  reordered: boolean
}

const withPositions = (nodes: readonly TestNode[], positions: Record<string, Point>): TestNode[] =>
  nodes.map((node) => ({ ...node, position: positions[node.id] ?? node.position }))

/**
 * Applies a drag end. A changed order re-stacks every Step in that order; an unchanged order keeps
 * the Step where it was dropped, clamped between its neighbours so the sort still yields the same
 * sequence.
 */
export const applyDrop = (
  nodes: readonly TestNode[],
  draggedId: string,
  dropped: Point,
  options: DropOptions = {},
): SequenceUpdate => {
  const probe = nodes.map((node) => (node.id === draggedId ? { ...node, position: dropped } : node))
  const result = resolveDrop(nodes, draggedId, dropped.y, options)
  const xOf = (id: string): number =>
    id === draggedId ? dropped.x : (nodes.find((n) => n.id === id)?.position?.x ?? 0)

  if (result.moved) {
    return {
      nodes: withPositions(probe, stackPositions(result.order, xOf)),
      edges: systemEdges(result.order),
      order: result.order,
      reordered: true,
    }
  }

  // Same order: keep the tidy-up, but never let it cross a neighbour.
  const order = result.order
  const yOf = (id: string): number => nodes.find((n) => n.id === id)?.position?.y ?? 0
  const above = order[result.index - 1]
  const below = order[result.index + 1]
  const min = above !== undefined ? yOf(above) + 1 : Number.NEGATIVE_INFINITY
  const max = below !== undefined ? yOf(below) - 1 : Number.POSITIVE_INFINITY
  const y = min > max ? yOf(draggedId) : Math.min(Math.max(dropped.y, min), max)
  return {
    nodes: probe.map((node) =>
      node.id === draggedId ? { ...node, position: { x: dropped.x, y } } : node,
    ),
    edges: systemEdges(order),
    order,
    reordered: false,
  }
}

/** Moves a Step one place earlier (-1) or later (+1); the keyboard and button alternative to dragging. */
export const shiftStep = (
  nodes: readonly TestNode[],
  id: string,
  delta: -1 | 1,
): SequenceUpdate | undefined => {
  const order = sortByPosition(nodes)
  const from = order.indexOf(id)
  const to = from + delta
  if (from < 0 || to < 0 || to >= order.length) return undefined
  const next = [...order]
  next.splice(from, 1)
  next.splice(to, 0, id)
  const xOf = (nodeId: string): number => nodes.find((n) => n.id === nodeId)?.position?.x ?? 0
  return {
    nodes: withPositions(nodes, stackPositions(next, xOf)),
    edges: systemEdges(next),
    order: next,
    reordered: true,
  }
}

/** Lays a list of Steps out in the given order (used to adopt a sequence, for example on conversion). */
export const layoutInOrder = (
  nodes: readonly TestNode[],
  order: readonly string[],
): SequenceUpdate => {
  const xOf = (nodeId: string): number => nodes.find((n) => n.id === nodeId)?.position?.x ?? 0
  return {
    nodes: withPositions(nodes, stackPositions(order, xOf)),
    edges: systemEdges(order),
    order: [...order],
    reordered: false,
  }
}

/** A new Step goes below the last one. */
export const nextPosition = (nodes: readonly Positioned[]): Point => {
  const ys = nodes.filter(hasPosition).map((node) => node.position!.y)
  return { x: 0, y: ys.length === 0 ? 0 : Math.max(...ys) + STEP_SPACING }
}

/** Accessible description of a reorder, for a screen-reader live region. */
export const describeMove = (name: string, from: number, to: number): string =>
  from === to
    ? `${name} stays at position ${to + 1}.`
    : `${name} moved from position ${from + 1} to position ${to + 1}; connections updated.`
