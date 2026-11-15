<template>
  <div class="ui-tabs">
    <div class="ui-tabs__list" role="tablist" :aria-label="label" @keydown="onKeydown">
      <button
        v-for="tab in tabs"
        :id="`${uid}-tab-${tab.id}`"
        :key="tab.id"
        type="button"
        role="tab"
        class="ui-tabs__tab"
        :class="{ 'is-active': tab.id === modelValue }"
        :aria-selected="tab.id === modelValue ? 'true' : 'false'"
        :aria-controls="`${uid}-panel-${tab.id}`"
        :tabindex="tab.id === modelValue ? 0 : -1"
        :disabled="tab.disabled"
        @click="emit('update:modelValue', tab.id)"
      >
        {{ tab.label }}
      </button>
    </div>
    <div
      :id="`${uid}-panel-${modelValue}`"
      class="ui-tabs__panel"
      role="tabpanel"
      :aria-labelledby="`${uid}-tab-${modelValue}`"
      tabindex="0"
    >
      <slot :active="modelValue" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { useId } from 'vue'

export interface UiTab {
  id: string
  label: string
  disabled?: boolean
}

const props = defineProps<{ modelValue: string; tabs: UiTab[]; label?: string }>()
const emit = defineEmits<{ 'update:modelValue': [id: string] }>()
const uid = useId()

function onKeydown(event: KeyboardEvent) {
  const enabled = props.tabs.filter((t) => !t.disabled)
  const index = enabled.findIndex((t) => t.id === props.modelValue)
  let next = -1
  if (event.key === 'ArrowRight') next = (index + 1) % enabled.length
  else if (event.key === 'ArrowLeft') next = (index - 1 + enabled.length) % enabled.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = enabled.length - 1
  if (next < 0) return
  event.preventDefault()
  const target = enabled[next]
  if (!target) return
  emit('update:modelValue', target.id)
  ;(
    (event.currentTarget as HTMLElement).querySelector(
      `[id="${uid}-tab-${target.id}"]`,
    ) as HTMLElement | null
  )?.focus()
}
</script>

<style scoped>
.ui-tabs__list {
  display: flex;
  gap: var(--td-space-1);
  overflow-x: auto;
  border-bottom: 1px solid var(--td-border);
}
.ui-tabs__tab {
  padding: var(--td-space-2) var(--td-space-4);
  font-size: var(--td-text-sm);
  font-weight: 600;
  white-space: nowrap;
  color: var(--td-text-muted);
  background: none;
  border: 0;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.ui-tabs__tab:hover:not(:disabled) {
  color: var(--td-text);
}
.ui-tabs__tab.is-active {
  color: var(--td-accent-text);
  border-bottom-color: var(--td-accent);
}
.ui-tabs__tab:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ui-tabs__panel {
  padding-top: var(--td-space-4);
}
</style>
