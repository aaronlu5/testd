<template>
  <div
    v-if="open"
    class="ui-alert"
    :class="`ui-alert--${variant}`"
    :role="variant === 'danger' || variant === 'warning' ? 'alert' : 'status'"
  >
    <Icon class="ui-alert__icon" :name="iconName" />
    <div class="ui-alert__body">
      <strong v-if="title" class="ui-alert__title">{{ title }}</strong>
      <div><slot /></div>
    </div>
    <button
      v-if="dismissible"
      type="button"
      class="ui-alert__close"
      aria-label="Dismiss"
      @click="dismiss"
    >
      <Icon name="x" :size="16" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import Icon from './Icon.vue'

const props = withDefaults(
  defineProps<{
    variant?: 'info' | 'success' | 'warning' | 'danger'
    title?: string
    dismissible?: boolean
  }>(),
  { variant: 'info', title: undefined },
)
const emit = defineEmits<{ dismiss: [] }>()

const open = ref(true)
const iconName = computed(
  () =>
    ({ info: 'info', success: 'check-circle', warning: 'warning', danger: 'error' })[props.variant],
)

function dismiss() {
  open.value = false
  emit('dismiss')
}
</script>

<style scoped>
.ui-alert {
  --a: var(--td-info);
  display: flex;
  gap: var(--td-space-3);
  align-items: flex-start;
  padding: var(--td-space-3) var(--td-space-4);
  font-size: var(--td-text-sm);
  color: var(--td-text);
  background: color-mix(in srgb, var(--a) 10%, var(--td-surface));
  border: 1px solid color-mix(in srgb, var(--a) 40%, transparent);
  border-left: 3px solid var(--a);
  border-radius: var(--td-radius-md);
}
.ui-alert--success {
  --a: var(--td-success);
}
.ui-alert--warning {
  --a: var(--td-warning);
}
.ui-alert--danger {
  --a: var(--td-danger);
}
.ui-alert__icon {
  color: var(--a);
  margin-top: 0.1rem;
}
.ui-alert__body {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}
.ui-alert__title {
  display: block;
  margin-bottom: 0.125rem;
}
.ui-alert__close {
  flex: none;
  display: grid;
  place-items: center;
  width: 1.75rem;
  height: 1.75rem;
  margin: -0.25rem -0.5rem -0.25rem 0;
  color: var(--td-text-muted);
  background: transparent;
  border: 0;
  border-radius: var(--td-radius-sm);
}
.ui-alert__close:hover {
  color: var(--td-text);
  background: var(--td-surface-3);
}
</style>
