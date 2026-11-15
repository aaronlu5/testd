<template>
  <UiButton
    class="ui-icon-btn"
    :variant="variant"
    :size="size"
    :to="to"
    :disabled="disabled"
    :aria-label="label"
    :title="label"
  >
    <slot><Icon :name="icon" /></slot>
  </UiButton>
</template>

<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'
import UiButton from './UiButton.vue'
import Icon from './Icon.vue'

withDefaults(
  defineProps<{
    /** Required accessible name (also used as the tooltip). */
    label: string
    icon?: string
    variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'outline-danger' | 'outline-secondary'
    size?: 'sm' | 'md' | 'lg'
    to?: RouteLocationRaw
    disabled?: boolean
  }>(),
  { icon: 'help-circle', variant: 'ghost', size: 'md', to: undefined },
)
</script>

<style scoped>
.ui-icon-btn {
  padding: 0;
  width: 2.25rem;
}
.ui-icon-btn.ui-btn--sm {
  width: 1.75rem;
}
@media (pointer: coarse) {
  .ui-icon-btn {
    width: 2.75rem;
  }
}
</style>
