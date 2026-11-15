<template>
  <component
    :is="tag"
    v-bind="attrsForTag"
    class="ui-dd-item"
    :class="{ 'is-danger': danger, 'is-active': active }"
    role="menuitem"
    :aria-disabled="disabled ? 'true' : undefined"
    :tabindex="disabled ? -1 : 0"
    @click="onClick"
  >
    <slot />
  </component>
</template>

<script setup lang="ts">
import { computed, inject } from 'vue'
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import { DROPDOWN_KEY } from './dropdown-context'

const props = defineProps<{
  to?: RouteLocationRaw
  href?: string
  disabled?: boolean
  danger?: boolean
  active?: boolean
}>()
const emit = defineEmits<{ click: [event: MouseEvent] }>()
const ctx = inject(DROPDOWN_KEY, null)

const tag = computed(() => (props.to ? RouterLink : props.href ? 'a' : 'button'))
const attrsForTag = computed(() =>
  props.to ? { to: props.to } : props.href ? { href: props.href } : { type: 'button' },
)

function onClick(event: MouseEvent) {
  if (props.disabled) {
    event.preventDefault()
    return
  }
  emit('click', event)
  ctx?.close(true)
}
</script>

<style scoped>
.ui-dd-item {
  display: flex;
  align-items: center;
  gap: var(--td-space-2);
  width: 100%;
  padding: 0.5rem var(--td-space-3);
  font-size: var(--td-text-sm);
  text-align: left;
  color: var(--td-text);
  background: transparent;
  border: 0;
  border-radius: var(--td-radius-sm);
  text-decoration: none;
  cursor: pointer;
}
.ui-dd-item:hover,
.ui-dd-item:focus-visible {
  background: var(--td-surface-3);
  color: var(--td-text);
  outline-offset: -2px;
}
.ui-dd-item.is-active {
  color: var(--td-accent-text);
  background: var(--td-accent-soft);
}
.ui-dd-item.is-danger {
  color: var(--td-danger);
}
.ui-dd-item[aria-disabled='true'] {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
