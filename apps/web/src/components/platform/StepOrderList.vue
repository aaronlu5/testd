<template>
  <div>
    <p v-if="items.length === 0" class="td-muted td-small td-mb-0">No Steps yet</p>
    <ol v-else class="steps" data-testid="step-list">
      <li
        v-for="(item, index) in items"
        :key="item.id"
        class="steps__item"
        :class="{ 'is-selected': item.id === selectedId }"
        :data-testid="`step-item-${item.id}`"
      >
        <span class="td-muted td-small">{{ index + 1 }}.</span>
        <button
          type="button"
          class="steps__select"
          data-testid="step-select"
          :aria-current="item.id === selectedId ? 'true' : undefined"
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          @click="emit('select', item.id)"
          @keydown.alt.up.prevent="canMove(index, -1) && emit('move', item.id, -1)"
          @keydown.alt.down.prevent="canMove(index, 1) && emit('move', item.id, 1)"
        >
          {{ item.name }}
        </button>
        <button
          type="button"
          class="steps__btn"
          :disabled="!canMove(index, -1)"
          :aria-label="`Move ${item.name} earlier, from position ${index + 1}`"
          @click="emit('move', item.id, -1)"
        >
          ↑
        </button>
        <button
          type="button"
          class="steps__btn"
          :disabled="!canMove(index, 1)"
          :aria-label="`Move ${item.name} later, from position ${index + 1}`"
          @click="emit('move', item.id, 1)"
        >
          ↓
        </button>
        <button
          type="button"
          class="steps__btn steps__btn--danger"
          :aria-label="`Delete ${item.name}`"
          @click="emit('remove', item.id)"
        >
          ×
        </button>
      </li>
    </ol>
    <p v-if="!movable && items.length > 1" class="td-small td-muted steps__note">
      Reordering is available once the Steps form one connected sequence.
    </p>
    <!-- Polite live region: screen readers hear each reorder without losing their place. -->
    <div class="td-sr-only" role="status" aria-live="polite" data-testid="order-announcement">
      {{ announcement }}
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  /** Steps in execution order. */
  items: { id: string; name: string }[]
  selectedId?: string
  /** False when the flow is not one valid chain (legacy mode only). */
  movable: boolean
  announcement?: string
}>()

const emit = defineEmits<{
  select: [id: string]
  move: [id: string, delta: -1 | 1]
  remove: [id: string]
}>()

const canMove = (index: number, delta: -1 | 1): boolean =>
  props.movable && index + delta >= 0 && index + delta < props.items.length
</script>

<style scoped>
.steps {
  display: flex;
  flex-direction: column;
  gap: var(--td-space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}
.steps__item {
  display: flex;
  align-items: center;
  gap: var(--td-space-1);
  padding: var(--td-space-1) var(--td-space-2);
  background: var(--td-surface-2);
  border: 1px solid var(--td-border);
  border-radius: var(--td-radius-md);
}
.steps__item.is-selected {
  background: var(--td-accent-soft);
  border-color: var(--td-accent);
}
.steps__select {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0;
  overflow: hidden;
  font-size: var(--td-text-sm);
  color: var(--td-text);
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: none;
  border: 0;
}
.steps__select:hover {
  color: var(--td-accent-text);
}
.steps__btn {
  padding: 0 var(--td-space-2);
  line-height: 1.5rem;
  color: var(--td-text-muted);
  background: var(--td-surface-3);
  border: 0;
  border-radius: var(--td-radius-sm);
}
.steps__btn:hover:not(:disabled) {
  color: var(--td-text);
}
.steps__btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.steps__btn--danger {
  color: var(--td-danger);
}
.steps__note {
  margin: var(--td-space-2) 0 0;
}
</style>
