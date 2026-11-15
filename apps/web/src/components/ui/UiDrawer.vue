<template>
  <Teleport to="body">
    <div v-if="modelValue" class="ui-overlay" @mousedown.self="close">
      <aside
        v-bind="$attrs"
        :id="id"
        ref="panel"
        class="ui-drawer"
        :class="[`is-${placement}`, `is-${size}`]"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
      >
        <header class="ui-drawer__header">
          <h2 :id="titleId" class="ui-drawer__title">
            <slot name="title">{{ title }}</slot>
          </h2>
          <button type="button" class="ui-drawer__close" aria-label="Close" @click="close">
            <Icon name="x" />
          </button>
        </header>
        <div class="ui-drawer__body"><slot /></div>
        <footer v-if="$slots.footer" class="ui-drawer__footer"><slot name="footer" /></footer>
      </aside>
    </div>
  </Teleport>
</template>

<script lang="ts">
export default { inheritAttrs: false }
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import Icon from './Icon.vue'
import { lockScroll, useFocusTrap } from '~/composables/useFocusTrap'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    title?: string
    placement?: 'end' | 'start'
    size?: 'sm' | 'md' | 'lg'
    id?: string
  }>(),
  { title: '', placement: 'end', size: 'md', id: undefined },
)
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; hidden: [] }>()

const panel = ref<HTMLElement | null>(null)
const titleId = `drawer-title-${useId()}`
const active = computed(() => props.modelValue)

function close() {
  emit('update:modelValue', false)
}

useFocusTrap(panel, active, close)

watch(
  active,
  (isOpen, wasOpen) => {
    if (isOpen) lockScroll(true)
    else if (wasOpen) {
      lockScroll(false)
      emit('hidden')
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  if (props.modelValue) lockScroll(false)
})
</script>

<style scoped>
.ui-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--td-z-overlay);
  background: var(--td-overlay);
  animation: ui-fade var(--td-dur) var(--td-ease);
}
.ui-drawer {
  position: absolute;
  top: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  width: min(100vw, var(--w));
  background: var(--td-surface);
  border-left: 1px solid var(--td-border-strong);
  box-shadow: var(--td-shadow-2);
  outline: none;
}
.is-sm {
  --w: 22rem;
}
.is-md {
  --w: 30rem;
}
.is-lg {
  --w: 48rem;
}
.is-end {
  right: 0;
  animation: ui-slide-end var(--td-dur) var(--td-ease);
}
.is-start {
  left: 0;
  border-left: 0;
  border-right: 1px solid var(--td-border-strong);
  animation: ui-slide-start var(--td-dur) var(--td-ease);
}
.ui-drawer__header {
  display: flex;
  align-items: center;
  gap: var(--td-space-3);
  padding: var(--td-space-3) var(--td-space-4);
  border-bottom: 1px solid var(--td-border);
}
.ui-drawer__title {
  flex: 1 1 auto;
  margin: 0;
  font-size: var(--td-text-md);
}
.ui-drawer__close {
  display: grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  color: var(--td-text-muted);
  background: transparent;
  border: 0;
  border-radius: var(--td-radius-sm);
}
.ui-drawer__close:hover {
  color: var(--td-text);
  background: var(--td-surface-3);
}
.ui-drawer__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--td-space-4);
}
.ui-drawer__footer {
  padding: var(--td-space-3) var(--td-space-4);
  border-top: 1px solid var(--td-border);
}
@keyframes ui-fade {
  from {
    opacity: 0;
  }
}
@keyframes ui-slide-end {
  from {
    transform: translateX(2rem);
    opacity: 0;
  }
}
@keyframes ui-slide-start {
  from {
    transform: translateX(-2rem);
    opacity: 0;
  }
}
</style>
