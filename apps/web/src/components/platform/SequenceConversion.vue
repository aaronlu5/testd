<template>
  <section class="conv" aria-labelledby="sequence-mode-title" data-testid="sequence-conversion">
    <h3 id="sequence-mode-title">Connections are drawn by hand</h3>
    <p class="td-small">
      This Test was authored with manual connections, so its order is kept exactly as saved. You can
      switch to <strong>position-driven sequencing</strong>: Steps run top to bottom as laid out on
      the canvas, you reorder them by dragging, and the connections are managed for you.
    </p>

    <UiButton
      v-if="!previewing"
      size="sm"
      variant="outline-primary"
      data-testid="open-conversion"
      @click="previewing = true"
    >
      Review the switch…
    </UiButton>

    <div v-else data-testid="conversion-preview">
      <div class="conv__label">Resulting order</div>
      <ol class="td-small conv__list" data-testid="conversion-order">
        <li v-for="(id, index) in preview.newOrder" :key="id">
          {{ names[id] ?? id }}
          <span v-if="preview.appended.includes(id)" class="conv__warn">
            (not connected before; added at the end)
          </span>
          <span v-if="index > 0" class="td-sr-only"
            >, connected after {{ names[preview.newOrder[index - 1] as string] }}</span
          >
        </li>
      </ol>
      <div class="conv__label">Connections</div>
      <ul class="td-small conv__list" data-testid="conversion-edges">
        <li v-for="edge in preview.edges" :key="`${edge.from}-${edge.to}`">
          {{ names[edge.from] ?? edge.from }} → {{ names[edge.to] ?? edge.to }}
        </li>
        <li v-if="preview.edges.length === 0" class="td-muted">None (a single Step)</li>
      </ul>
      <p class="td-small" data-testid="conversion-summary">
        <template v-if="preview.connectionsChange">
          The connections will change as listed above.
        </template>
        <template v-else>
          The order and connections stay the same; only their management changes.
        </template>
        Nothing is saved until you press Save, and you can undo the switch before then.
      </p>
      <div class="td-row">
        <UiButton size="sm" variant="primary" data-testid="apply-conversion" @click="apply">
          Switch to position-driven
        </UiButton>
        <UiButton
          size="sm"
          variant="outline-secondary"
          data-testid="cancel-conversion"
          @click="previewing = false"
        >
          Keep manual connections
        </UiButton>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import type { ConversionPreview } from '~/stores/editor'

defineProps<{ preview: ConversionPreview; names: Record<string, string> }>()
const emit = defineEmits<{ apply: [] }>()

const previewing = ref(false)
const apply = () => {
  previewing.value = false
  emit('apply')
}
</script>

<style scoped>
.conv {
  margin-bottom: var(--td-space-2);
  padding: var(--td-space-3);
  background: var(--td-surface-2);
  border: 1px solid var(--td-border);
  border-radius: var(--td-radius-md);
}
.conv h3 {
  margin: 0 0 var(--td-space-1);
  font-size: var(--td-text-sm);
}
.conv p {
  margin: 0 0 var(--td-space-2);
}
.conv__label {
  margin-bottom: var(--td-space-1);
  font-size: var(--td-text-sm);
  font-weight: 650;
}
.conv__list {
  margin: 0 0 var(--td-space-2);
  padding-left: var(--td-space-5);
}
.conv__warn {
  color: var(--td-warning);
}
</style>
