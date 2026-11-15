import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  JsonObject,
  JsonValue,
  StepTypeMetadata,
  TestDefinition,
  TestEdge,
  TestNode,
} from '~/api/types'
import type { Draft } from '~/api/platform'
import {
  MAX_NODES,
  NODE_ID_PATTERN,
  addNode,
  analyzeGraph,
  canConnect,
  displayOrder,
  moveNode,
  removeNode,
  uniqueNodeId,
  type ConnectionCheck,
} from '~/components/platform/flow-graph'
import {
  applyDrop,
  describeMove,
  layoutInOrder,
  nextPosition,
  relaxedPositions,
  shiftStep,
  sortByPosition,
  systemEdges,
  type Point,
} from '~/components/platform/position-sequence'

export type EditorSettings = {
  layoutDirection: 'vertical'
  autoSequenceFromPosition: boolean
}

export type EditorDraft = {
  name: string
  description: string
  tags: string[]
  variables: Record<string, JsonValue>
  nodes: TestNode[]
  edges: TestEdge[]
  editor: EditorSettings
  /** Ids of the Mock API setups served while this Test runs. */
  mockSetupIds: string[]
}

export type ClientIssue = { message: string; nodeId?: string }

/** What the author sees before choosing position-driven sequencing for an existing Test. */
export type ConversionPreview = {
  currentOrder: string[]
  newOrder: string[]
  edges: TestEdge[]
  /** Steps that were not part of the connected sequence and will be appended at the end. */
  appended: string[]
  /** True when the resulting connections differ from the ones stored today. */
  connectionsChange: boolean
}

type HistoryEntry = { nodes: TestNode[]; edges: TestEdge[]; editor: EditorSettings }

/** How many leading Steps of `order` are joined to their successor by a stored connection. */
const connectedPrefix = (order: readonly string[], edges: readonly TestEdge[]): number => {
  const linked = new Set(edges.map((edge) => `${edge.from}>${edge.to}`))
  let length = order.length === 0 ? 0 : 1
  while (length < order.length && linked.has(`${order[length - 1]}>${order[length]}`)) length += 1
  return length
}

const HISTORY_LIMIT = 100
const DEFAULT_EDITOR: EditorSettings = {
  layoutDirection: 'vertical',
  autoSequenceFromPosition: true,
}
const LEGACY_EDITOR: EditorSettings = {
  layoutDirection: 'vertical',
  autoSequenceFromPosition: false,
}

// Query results are reactive proxies, which structuredClone cannot copy; JSON values round-trip.
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const blank = (): EditorDraft => ({
  name: '',
  description: '',
  tags: [],
  variables: {},
  nodes: [],
  edges: [],
  editor: { ...DEFAULT_EDITOR },
  mockSetupIds: [],
})

const fromAsset = (asset: TestDefinition): EditorDraft => ({
  name: asset.name,
  description: asset.description ?? '',
  tags: [...asset.tags],
  variables: clone(asset.variables) as Record<string, JsonValue>,
  nodes: clone(asset.nodes) as TestNode[],
  edges: clone(asset.edges) as TestEdge[],
  editor: asset.editor ? { ...asset.editor } : { ...LEGACY_EDITOR },
  mockSetupIds: [...(asset.helpers?.mockApi?.setupIds ?? [])],
})

/**
 * Editor state only: the Test being edited, the selection, undo/redo history, and whether the
 * draft differs from what was last loaded or saved. Server data lives in TanStack Query; nothing
 * here is persisted.
 *
 * In position-driven mode the order of Steps comes from their positions and the connections are
 * system-managed: every layout change regenerates them here for an instant preview, and the
 * server's normalized result replaces them on save.
 */
export const useEditorStore = defineStore('editor', () => {
  const draft = ref<EditorDraft>(blank())
  const baseline = ref(JSON.stringify(blank()))
  const assetId = ref<string>()
  const version = ref<number>()
  const selectedId = ref<string>()
  const past = ref<HistoryEntry[]>([])
  const future = ref<HistoryEntry[]>([])
  /** Latest accessible description of a layout change, for a live region. */
  const announcement = ref('')

  const dirty = computed(() => JSON.stringify(draft.value) !== baseline.value)
  const positionDriven = computed(() => draft.value.editor.autoSequenceFromPosition)
  const analysis = computed(() => analyzeGraph(draft.value.nodes, draft.value.edges))
  const selected = computed(() => draft.value.nodes.find((node) => node.id === selectedId.value))
  const isNew = computed(() => assetId.value === undefined)
  const canUndo = computed(() => past.value.length > 0)
  const canRedo = computed(() => future.value.length > 0)

  /** Execution order as the editor currently understands it. */
  const order = computed(() =>
    positionDriven.value
      ? sortByPosition(draft.value.nodes)
      : displayOrder(draft.value.nodes, draft.value.edges),
  )

  const clientIssues = computed<ClientIssue[]>(() => {
    const issues: ClientIssue[] = []
    const { name, nodes } = draft.value
    if (name.trim() === '') issues.push({ message: 'Give the Test a name.' })
    if (name.length > 200) issues.push({ message: 'The name must be at most 200 characters.' })
    if (nodes.length > MAX_NODES) issues.push({ message: `A Test has at most ${MAX_NODES} Steps.` })
    for (const node of nodes) {
      if (!NODE_ID_PATTERN.test(node.id))
        issues.push({ message: `"${node.id}" is not a valid Step id.`, nodeId: node.id })
      if (node.name.trim() === '')
        issues.push({ message: 'Every Step needs a name.', nodeId: node.id })
      const timeout = node.execution?.timeoutSeconds
      if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1))
        issues.push({
          message: `${node.name}: the timeout must be a whole number of seconds.`,
          nodeId: node.id,
        })
      const attempts = node.execution?.retry?.maxAttempts
      if (attempts !== undefined && (!Number.isInteger(attempts) || attempts < 1 || attempts > 20))
        issues.push({
          message: `${node.name}: attempts must be between 1 and 20.`,
          nodeId: node.id,
        })
    }
    for (const issue of analysis.value.issues)
      issues.push({ message: issue.message, nodeId: issue.nodeIds[0] })
    return issues
  })

  // --- history ----------------------------------------------------------------------------
  const entry = (): HistoryEntry => ({
    nodes: clone(draft.value.nodes),
    edges: clone(draft.value.edges),
    editor: { ...draft.value.editor },
  })

  /** Call before a layout or structure change so it can be undone. */
  const commit = () => {
    past.value.push(entry())
    if (past.value.length > HISTORY_LIMIT) past.value.shift()
    future.value = []
  }

  /**
   * Restores layout, connections and settings from `target`. Parameters the author edited since
   * stay as they are for Steps that still exist; Steps that exist only in `target` come back.
   */
  const restore = (target: HistoryEntry) => {
    const current = new Map(draft.value.nodes.map((node) => [node.id, node]))
    draft.value.nodes = target.nodes.map((node) => {
      const live = current.get(node.id)
      return live ? { ...live, position: node.position } : clone(node)
    })
    if (!draft.value.nodes.some((node) => node.position)) {
      for (const node of draft.value.nodes) delete node.position
    }
    draft.value.edges = clone(target.edges)
    draft.value.editor = { ...target.editor }
    if (selectedId.value && !draft.value.nodes.some((node) => node.id === selectedId.value))
      selectedId.value = undefined
  }

  const undo = (): boolean => {
    const target = past.value.pop()
    if (!target) return false
    future.value.push(entry())
    restore(target)
    announcement.value = 'Undid the last layout change.'
    return true
  }

  const redo = (): boolean => {
    const target = future.value.pop()
    if (!target) return false
    past.value.push(entry())
    restore(target)
    announcement.value = 'Redid the layout change.'
    return true
  }

  const clearHistory = () => {
    past.value = []
    future.value = []
  }

  // --- loading and saving -----------------------------------------------------------------
  const load = (asset: TestDefinition) => {
    draft.value = fromAsset(asset)
    // Older Tests were saved with Steps closer together than the cards need. Re-space them for
    // display; the order is unchanged, so this is not an edit and the Test is not marked dirty.
    if (draft.value.editor.autoSequenceFromPosition) {
      const relaxed = relaxedPositions(draft.value.nodes)
      if (relaxed) {
        draft.value.nodes = draft.value.nodes.map((node) => ({
          ...node,
          position: relaxed[node.id] ?? node.position,
        }))
      }
    }
    baseline.value = JSON.stringify(draft.value)
    assetId.value = asset.id
    version.value = asset.version
    selectedId.value = undefined
    announcement.value = ''
    clearHistory()
  }

  const reset = (seed?: Partial<EditorDraft>) => {
    draft.value = { ...blank(), ...seed }
    baseline.value = JSON.stringify(blank())
    assetId.value = undefined
    version.value = undefined
    selectedId.value = undefined
    announcement.value = ''
    clearHistory()
  }

  /**
   * Adopts the saved Test. The server's layout, edges and settings are authoritative, so they
   * replace the local preview; the selection is kept when that Step still exists.
   */
  const markSaved = (asset: TestDefinition) => {
    const keep = selectedId.value
    draft.value = {
      ...fromAsset(asset),
      // The author's own text is what was just saved; keep it exactly as typed.
      name: draft.value.name,
      description: draft.value.description,
    }
    baseline.value = JSON.stringify(draft.value)
    assetId.value = asset.id
    version.value = asset.version
    selectedId.value = keep && draft.value.nodes.some((node) => node.id === keep) ? keep : undefined
    clearHistory()
  }

  // --- structure --------------------------------------------------------------------------
  const addStep = (definition: StepTypeMetadata): string => {
    commit()
    const id = uniqueNodeId(draft.value.nodes, definition.type)
    const node: TestNode = {
      id,
      type: definition.type,
      name: definition.displayName,
      parameters: clone(definition.defaults ?? {}) as JsonObject,
    }
    if (positionDriven.value) {
      node.position = nextPosition(draft.value.nodes)
      draft.value.nodes = [...draft.value.nodes, node]
      draft.value.edges = systemEdges(sortByPosition(draft.value.nodes))
    } else {
      const next = addNode(draft.value.nodes, draft.value.edges, node)
      draft.value.nodes = next.nodes
      draft.value.edges = next.edges
    }
    selectedId.value = id
    return id
  }

  const removeStep = (id: string) => {
    commit()
    if (positionDriven.value) {
      draft.value.nodes = draft.value.nodes.filter((node) => node.id !== id)
      draft.value.edges = systemEdges(sortByPosition(draft.value.nodes))
    } else {
      const next = removeNode(draft.value.nodes, draft.value.edges, id)
      draft.value.nodes = next.nodes
      draft.value.edges = next.edges
    }
    if (selectedId.value === id) selectedId.value = undefined
  }

  const nameOf = (id: string): string => draft.value.nodes.find((n) => n.id === id)?.name ?? id

  /** Applies a computed sequence and announces what happened to `id`. */
  const apply = (
    id: string,
    before: string[],
    update: { nodes: TestNode[]; edges: TestEdge[]; order: string[] },
  ) => {
    draft.value.nodes = update.nodes
    draft.value.edges = update.edges
    announcement.value = describeMove(nameOf(id), before.indexOf(id), update.order.indexOf(id))
  }

  /** Move earlier (-1) or later (+1): the keyboard and button alternative to dragging. */
  const moveStep = (id: string, delta: -1 | 1): boolean => {
    if (positionDriven.value) {
      const before = sortByPosition(draft.value.nodes)
      const update = shiftStep(draft.value.nodes, id, delta)
      if (!update) return false
      commit()
      apply(id, before, update)
      return true
    }
    const edges = moveNode(draft.value.nodes, draft.value.edges, id, delta)
    if (!edges) return false
    commit()
    draft.value.edges = edges
    return true
  }

  /** A drag ended at `point`. Returns whether the sequence changed. */
  const dropStep = (id: string, point: Point, nodeHeight?: number): boolean => {
    if (!positionDriven.value) return false
    const before = sortByPosition(draft.value.nodes)
    const update = applyDrop(draft.value.nodes, id, point, { nodeHeight })
    const moved =
      update.reordered || JSON.stringify(update.nodes) !== JSON.stringify(draft.value.nodes)
    if (!moved) return false
    commit()
    apply(id, before, update)
    return update.reordered
  }

  const connect = (from: string, to: string): ConnectionCheck => {
    if (positionDriven.value)
      return { ok: false, reason: "Connections follow the Steps' positions; move a Step instead." }
    const check = canConnect(draft.value.nodes, draft.value.edges, from, to)
    if (check.ok) {
      commit()
      draft.value.edges = [...draft.value.edges, { from, to }]
    }
    return check
  }

  const disconnect = (from: string, to: string) => {
    if (positionDriven.value) return
    commit()
    draft.value.edges = draft.value.edges.filter((edge) => !(edge.from === from && edge.to === to))
  }

  const updateStep = (id: string, patch: Partial<Omit<TestNode, 'id' | 'type'>>) => {
    draft.value.nodes = draft.value.nodes.map((node) =>
      node.id === id ? { ...node, ...patch } : node,
    )
  }

  // --- opting an existing Test in -----------------------------------------------------------
  const conversionPreview = (): ConversionPreview => {
    const { nodes, edges } = draft.value
    const currentOrder = displayOrder(nodes, edges)
    const newOrder = currentOrder
    const generated = systemEdges(newOrder)
    const key = (e: TestEdge) => `${e.from}>${e.to}`
    const stored = new Set(edges.map(key))
    return {
      currentOrder,
      newOrder,
      edges: generated,
      appended: currentOrder.slice(connectedPrefix(currentOrder, edges)),
      connectionsChange:
        generated.length !== edges.length || generated.some((edge) => !stored.has(key(edge))),
    }
  }

  const enableSequencing = (): boolean => {
    if (positionDriven.value) return false
    const preview = conversionPreview()
    commit()
    const update = layoutInOrder(draft.value.nodes, preview.newOrder)
    draft.value.nodes = update.nodes
    draft.value.edges = update.edges
    draft.value.editor = { ...draft.value.editor, autoSequenceFromPosition: true }
    announcement.value = 'Steps are now ordered by their position; connections are managed for you.'
    return true
  }

  const toRequestBody = (): Draft<TestDefinition> => {
    const { name, description, tags, variables, nodes, edges, editor, mockSetupIds } = draft.value
    return {
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      tags,
      variables,
      nodes,
      edges,
      editor,
      ...(mockSetupIds.length > 0 ? { helpers: { mockApi: { setupIds: mockSetupIds } } } : {}),
    }
  }

  return {
    draft,
    assetId,
    version,
    selectedId,
    selected,
    dirty,
    isNew,
    analysis,
    clientIssues,
    positionDriven,
    order,
    announcement,
    canUndo,
    canRedo,
    load,
    reset,
    markSaved,
    addStep,
    removeStep,
    moveStep,
    dropStep,
    connect,
    disconnect,
    updateStep,
    undo,
    redo,
    conversionPreview,
    enableSequencing,
    toRequestBody,
  }
})
