<template>
  <span
    class="ui-tip"
    @mouseenter="show = true"
    @mouseleave="show = false"
    @focusin="show = true"
    @focusout="show = false"
    @keydown.esc="show = false"
  >
    <span :aria-describedby="show ? id : undefined"><slot /></span>
    <span v-if="show" :id="id" role="tooltip" class="ui-tip__bubble" :class="`is-${placement}`">
      {{ text }}
    </span>
  </span>
</template>

<script setup lang="ts">
import { ref, useId } from 'vue'

withDefaults(defineProps<{ text: string; placement?: 'top' | 'bottom' }>(), { placement: 'top' })
const show = ref(false)
const id = `tip-${useId()}`
</script>

<style scoped>
.ui-tip {
  position: relative;
  display: inline-flex;
}
.ui-tip__bubble {
  position: absolute;
  left: 50%;
  z-index: var(--td-z-dropdown);
  transform: translateX(-50%);
  max-width: 16rem;
  padding: 0.25rem 0.5rem;
  font-size: var(--td-text-xs);
  line-height: 1.35;
  white-space: normal;
  color: var(--td-text);
  background: var(--td-surface-3);
  border: 1px solid var(--td-border-strong);
  border-radius: var(--td-radius-sm);
  box-shadow: var(--td-shadow-2);
  pointer-events: none;
}
.is-top {
  bottom: calc(100% + 0.375rem);
}
.is-bottom {
  top: calc(100% + 0.375rem);
}
</style>
