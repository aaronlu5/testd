<template>
  <div
    class="insertion-marker"
    :style="{ top: `${top}px`, left: `${left}px`, width: `${width}px` }"
    aria-hidden="true"
    data-testid="insertion-marker"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  /** Flow-space y of the insertion point and x of the column. */
  y: number
  x: number
  width: number
  viewport: { x: number; y: number; zoom: number }
}>()

// Positioned in screen space from the Vue Flow viewport, so it follows panning and zooming.
const top = computed(() => props.viewport.y + props.y * props.viewport.zoom - 2)
const left = computed(() => props.viewport.x + (props.x - 8) * props.viewport.zoom)
const width = computed(() => (props.width + 16) * props.viewport.zoom)
</script>

<style scoped>
.insertion-marker {
  position: absolute;
  z-index: 5;
  height: 4px;
  pointer-events: none;
  background: var(--td-accent);
  border-radius: 2px;
  box-shadow: 0 0 0 2px var(--td-accent-soft);
}
</style>
