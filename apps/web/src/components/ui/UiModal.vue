<template>
  <Teleport to="body">
    <div v-if="modelValue" class="ui-overlay" @mousedown.self="close">
      <div
        v-bind="$attrs"
        ref="panel"
        class="ui-modal"
        :class="`is-${size}`"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
      >
        <header class="ui-modal__header">
          <h2 :id="titleId" class="ui-modal__title">
            <slot name="title">{{ title }}</slot>
          </h2>
          <button type="button" class="ui-modal__close" aria-label="Close" @click="close">
            <Icon name="x" />
          </button>
        </header>
        <div class="ui-modal__body"><slot /></div>
        <footer v-if="$slots.footer" class="ui-modal__footer"><slot name="footer" /></footer>
      </div>
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
  defineProps<{ modelValue: boolean; title?: string; size?: 'sm' | 'md' | 'lg' }>(),
  { title: '', size: 'md' },
)
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; hidden: [] }>()

const panel = ref<HTMLElement | null>(null)
const titleId = `modal-title-${useId()}`
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
  z-index: var(--td-z-dialog);
  display: grid;
  place-items: center;
  padding: var(--td-space-4);
  background: var(--td-overlay);
  animation: ui-fade var(--td-dur) var(--td-ease);
}
.ui-modal {
  display: flex;
  flex-direction: column;
  width: min(100%, var(--w));
  max-height: calc(100vh - 2rem);
  background: var(--td-surface);
  border: 1px solid var(--td-border-strong);
  border-radius: var(--td-radius-lg);
  box-shadow: var(--td-shadow-2);
  outline: none;
  animation: ui-pop var(--td-dur) var(--td-ease);
}
.is-sm {
  --w: 24rem;
}
.is-md {
  --w: 36rem;
}
.is-lg {
  --w: 56rem;
}
.ui-modal__header {
  display: flex;
  align-items: center;
  gap: var(--td-space-3);
  padding: var(--td-space-3) var(--td-space-4);
  border-bottom: 1px solid var(--td-border);
}
.ui-modal__title {
  flex: 1 1 auto;
  margin: 0;
  font-size: var(--td-text-md);
}
.ui-modal__close {
  display: grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  color: var(--td-text-muted);
  background: transparent;
  border: 0;
  border-radius: var(--td-radius-sm);
}
.ui-modal__close:hover {
  color: var(--td-text);
  background: var(--td-surface-3);
}
.ui-modal__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--td-space-4);
}
.ui-modal__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--td-space-2);
  padding: var(--td-space-3) var(--td-space-4);
  border-top: 1px solid var(--td-border);
}
@keyframes ui-fade {
  from {
    opacity: 0;
  }
}
@keyframes ui-pop {
  from {
    transform: translateY(0.5rem) scale(0.98);
    opacity: 0;
  }
}
</style>
