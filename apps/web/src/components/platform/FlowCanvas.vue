<template>
  <div class="flow-canvas" :style="{ height }" data-testid="flow-canvas">
    <VueFlow
      :id="flowId"
      :nodes-draggable="draggable"
      :nodes-connectable="!readonly && !sequenceMode"
      :elements-selectable="true"
      :is-valid-connection="isValid"
      :min-zoom="0.4"
      :max-zoom="1"
      :delete-key-code="null"
      fit-view-on-init
      @connect="onConnect"
      @node-click="({ node }) => emit('select', node.id)"
      @edge-click="({ edge }) => emit('select-edge', { from: edge.source, to: edge.target })"
      @pane-click="onPaneClick"
      @node-drag="onDrag"
      @node-drag-stop="onDragStop"
    >
      <template #node-step="{ data, id }">
        <div
          class="step-node"
          :class="{
            selected: id === selectedId,
            invalid: data.invalid,
            breakpoint: data.type === 'breakpoint',
            paused: data.status === 'Paused',
            dragging: id === draggingId,
          }"
          role="button"
          tabindex="0"
          :aria-label="describeNode(data)"
          :aria-pressed="id === selectedId"
          :aria-current="data.status === 'Paused' ? 'step' : undefined"
          :aria-keyshortcuts="draggable ? 'Alt+ArrowUp Alt+ArrowDown' : undefined"
          @keydown.enter.prevent="emit('select', id)"
          @keydown.space.prevent="emit('select', id)"
          @keydown.alt.up.prevent="draggable && emit('move', id, -1)"
          @keydown.alt.down.prevent="draggable && emit('move', id, 1)"
        >
          <Handle
            type="target"
            :position="Position.Top"
            :connectable="!readonly && !sequenceMode"
          />
          <div class="step-node__body">
            <div class="step-node__top">
              <span class="step-node__index">{{ data.index }}</span>
              <StatusBadge v-if="data.status" :status="data.status" />
            </div>
            <BreakpointNode
              v-if="data.type === 'breakpoint'"
              :name="data.name"
              :enabled="data.enabled"
            />
            <template v-else>
              <div class="step-node__name">{{ data.name }}</div>
              <div class="step-node__type">{{ data.type }}</div>
            </template>
          </div>
          <Handle
            type="source"
            :position="Position.Bottom"
            :connectable="!readonly && !sequenceMode"
          />
        </div>
      </template>
    </VueFlow>
    <SequenceInsertionMarker
      v-if="marker"
      :x="marker.x"
      :y="marker.y"
      :width="NODE_WIDTH"
      :viewport="viewport"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import {
  Handle,
  Position,
  VueFlow,
  useVueFlow,
  type Connection,
  type NodeDragEvent,
} from '@vue-flow/core'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import type { TestEdge, TestNode } from '~/api/types'
import BreakpointNode from '~/components/platform/BreakpointNode.vue'
import SequenceInsertionMarker from '~/components/platform/SequenceInsertionMarker.vue'
import StatusBadge from '~/components/platform/StatusBadge.vue'
import { canConnect, displayOrder, layoutPositions } from '~/components/platform/flow-graph'
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  hasPosition,
  insertionY,
  relaxedPositions,
  resolveDrop,
  sortByPosition,
} from '~/components/platform/position-sequence'

const props = withDefaults(
  defineProps<{
    nodes: TestNode[]
    edges: TestEdge[]
    selectedId?: string
    /** Execution status per node id, for the Run console. */
    statuses?: Record<string, string>
    invalidIds?: string[]
    readonly?: boolean
    /** Position-driven mode: Steps can be dragged and connections are managed automatically. */
    sequenceMode?: boolean
    height?: string
  }>(),
  {
    statuses: () => ({}),
    invalidIds: () => [],
    readonly: false,
    sequenceMode: false,
    height: '36rem',
  },
)

const emit = defineEmits<{
  select: [id: string | undefined]
  'select-edge': [edge: TestEdge | undefined]
  connect: [from: string, to: string]
  rejected: [reason: string]
  /** A drag ended: the Step's final position. */
  drop: [id: string, position: { x: number; y: number }, height: number]
  /** Keyboard alternative: move one place earlier (-1) or later (+1). */
  move: [id: string, delta: -1 | 1]
}>()

// Each canvas gets its own Vue Flow store. The default store is shared and outlives the component,
// so a new Test would otherwise start with the previous Test's Steps.
const flowId = `canvas-${useId()}`
const { fitView, setNodes, setEdges, viewport, findNode } = useVueFlow(flowId)

const draggable = computed(() => props.sequenceMode && !props.readonly)

const positions = computed(() => layoutPositions(props.nodes, props.edges))
const order = computed(() =>
  props.sequenceMode && props.nodes.every(hasPosition)
    ? sortByPosition(props.nodes)
    : displayOrder(props.nodes, props.edges),
)

// A Run's snapshot is read-only and may hold an older, tighter layout; space it out for display.
const relaxed = computed(() => (draggable.value ? undefined : relaxedPositions(props.nodes)))

const positionOf = (node: TestNode) =>
  props.sequenceMode && hasPosition(node)
    ? { ...(relaxed.value?.[node.id] ?? node.position!) }
    : (positions.value[node.id] ?? { x: 0, y: 0 })

const flowNodes = computed(() =>
  props.nodes.map((node) => ({
    id: node.id,
    type: 'step',
    position: positionOf(node),
    draggable: draggable.value,
    data: {
      name: node.name,
      type: node.type,
      enabled: node.parameters.enabled !== false,
      index: order.value.indexOf(node.id) + 1,
      status: props.statuses[node.id],
      invalid: props.invalidIds.includes(node.id),
    },
  })),
)

const flowEdges = computed(() =>
  props.edges.map((edge) => ({
    id: `${edge.from}->${edge.to}`,
    source: edge.from,
    target: edge.to,
    type: 'smoothstep',
    animated: props.statuses[edge.to] === 'Running',
    // System-managed connections are shown for orientation but cannot be edited by hand.
    selectable: !props.sequenceMode,
    class: edge.metadata?.systemManaged ? 'system-managed' : undefined,
  })),
)

// Vue Flow also runs this check on the edges we hand it, which are already in `props.edges`; an
// existing connection must therefore count as valid or it would be rejected as a second branch.
const isValid = (connection: Connection): boolean =>
  props.edges.some((edge) => edge.from === connection.source && edge.to === connection.target) ||
  canConnect(props.nodes, props.edges, connection.source, connection.target).ok

const onConnect = (connection: Connection) => {
  const check = canConnect(props.nodes, props.edges, connection.source, connection.target)
  if (check.ok) emit('connect', connection.source, connection.target)
  else emit('rejected', check.reason)
}

const onPaneClick = () => {
  emit('select', undefined)
  emit('select-edge', undefined)
}

// --- dragging ------------------------------------------------------------------------------
const draggingId = ref<string>()
const marker = ref<{ x: number; y: number }>()

const heightOf = (id: string): number => findNode(id)?.dimensions?.height || NODE_HEIGHT

/** While dragging, show where the Step would land using the same rule as the drop. */
const onDrag = ({ node }: NodeDragEvent) => {
  if (!draggable.value) return
  draggingId.value = node.id
  const height = heightOf(node.id)
  const result = resolveDrop(props.nodes, node.id, node.position.y, { nodeHeight: height })
  marker.value = {
    x: node.position.x,
    y: insertionY(props.nodes, result.order, node.id, height),
  }
}

const onDragStop = async ({ node }: NodeDragEvent) => {
  if (!draggable.value) return
  const height = heightOf(node.id)
  draggingId.value = undefined
  marker.value = undefined
  emit('drop', node.id, { x: node.position.x, y: node.position.y }, height)
  // The model decides where the Step ends up (re-stacked, clamped or put back); show exactly that.
  await nextTick()
  setNodes(flowNodes.value)
}

// Nodes go in first and edges one tick later: Vue Flow discards an edge whose nodes it has not
// received yet, which made new connections invisible until the Test was reloaded.
const sync = async () => {
  setNodes(flowNodes.value)
  await nextTick()
  setEdges(flowEdges.value)
}

const describeNode = (data: { name: string; type: string; status?: string; index: number }) =>
  `Step ${data.index}: ${data.name}, ${data.type}${data.status ? ', ' + data.status : ''}`

watch(flowNodes, () => {
  if (draggingId.value) return // never reposition a card under the pointer
  void sync()
})
watch(flowEdges, async (edges) => {
  await nextTick()
  setEdges(edges)
})
onMounted(sync)
onBeforeUnmount(() => {
  setNodes([])
  setEdges([])
})

// Re-fit whenever Steps are added, removed or re-ordered so the whole sequence stays in view.
watch(
  () => `${props.nodes.length}:${order.value.join(',')}`,
  async () => {
    await nextTick()
    // Vue Flow measures a new card after it is rendered; fitting before that uses a stale size and
    // leaves the sequence off-centre or cut off, so wait two frames.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    void fitView({ padding: 0.2, maxZoom: 1, duration: 150 })
  },
)
</script>

<style scoped>
.flow-canvas {
  position: relative;
  overflow: hidden;
  background:
    radial-gradient(circle at 1px 1px, var(--td-border-strong) 1px, transparent 0) 0 0 / 1.5rem
      1.5rem,
    var(--td-surface-2);
  border: 1px solid var(--td-border);
  border-radius: var(--td-radius-md);
}
.step-node {
  width: 12rem;
  cursor: pointer;
  color: var(--td-text);
  background: var(--td-surface);
  border: 1px solid var(--td-border-strong);
  border-radius: var(--td-radius-md);
  box-shadow: var(--td-shadow-1);
}
.step-node__body {
  padding: var(--td-space-2) var(--td-space-3);
}
.step-node__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--td-space-2);
}
.step-node__index {
  font-family: var(--td-font-mono);
  font-size: var(--td-text-xs);
  color: var(--td-text-faint);
}
.step-node__name {
  overflow: hidden;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.step-node__type {
  overflow: hidden;
  font-size: var(--td-text-xs);
  color: var(--td-text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.step-node.selected {
  border-color: var(--td-accent);
  box-shadow: 0 0 0 2px var(--td-accent-soft);
}
.step-node.invalid {
  border-color: var(--td-danger);
}
.step-node.breakpoint {
  border-style: dashed;
  border-color: var(--td-warning);
}
/* The Breakpoint a Run is waiting at: unmistakable, and not colour alone (thick frame + glow). */
.step-node.paused {
  border: 3px solid var(--td-paused);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--td-paused) 30%, transparent);
}
.step-node.dragging {
  opacity: 0.85;
  cursor: grabbing;
}
.step-node:focus-visible {
  outline: 2px solid var(--td-focus);
  outline-offset: 2px;
}
.flow-canvas :deep(.vue-flow__edge.system-managed .vue-flow__edge-path) {
  stroke-dasharray: 4 3;
}
.flow-canvas :deep(.vue-flow__edge-path) {
  stroke: var(--td-text-faint);
  stroke-width: 1.75;
}
.flow-canvas :deep(.vue-flow__edge.selected .vue-flow__edge-path) {
  stroke: var(--td-accent);
}
/* Larger connection dots, so they are easy to grab and to drop onto. */
.flow-canvas :deep(.vue-flow__node .vue-flow__handle) {
  width: 16px;
  height: 16px;
  background: var(--td-surface);
  border: 2px solid var(--td-accent);
  border-radius: 50%;
  transition:
    transform 0.1s ease,
    background-color 0.1s ease;
}
.flow-canvas :deep(.vue-flow__node .vue-flow__handle-top) {
  top: -8px;
}
.flow-canvas :deep(.vue-flow__node .vue-flow__handle-bottom) {
  bottom: -8px;
}
.flow-canvas :deep(.vue-flow__node .vue-flow__handle:hover),
.flow-canvas :deep(.vue-flow__node .vue-flow__handle.connectingfrom),
.flow-canvas :deep(.vue-flow__node .vue-flow__handle.connectingto) {
  background: var(--td-accent);
}
.flow-canvas :deep(.vue-flow__node .vue-flow__handle.valid) {
  background: var(--td-success);
  border-color: var(--td-success);
}
.flow-canvas :deep(.vue-flow__connection-path) {
  stroke: var(--td-accent);
}
@media (prefers-reduced-motion: reduce) {
  .flow-canvas :deep(.vue-flow__node .vue-flow__handle) {
    transition: none;
  }
}
</style>
