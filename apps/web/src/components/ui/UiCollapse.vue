<template>
  <div class="ui-collapse">
    <button
      type="button"
      class="ui-collapse__toggle"
      :aria-expanded="modelValue ? 'true' : 'false'"
      :aria-controls="panelId"
      @click="emit('update:modelValue', !modelValue)"
    >
      <Icon
        name="chevron-right"
        :size="16"
        class="ui-collapse__chevron"
        :class="{ 'is-open': modelValue }"
      />
      <slot name="title">{{ title }}</slot>
    </button>
    <div v-show="modelValue" :id="panelId" class="ui-collapse__panel" role="region">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { useId } from 'vue'
import Icon from './Icon.vue'

defineProps<{ modelValue: boolean; title?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const panelId = `collapse-${useId()}`
</script>

<style scoped>
.ui-collapse__toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--td-space-2);
  padding: var(--td-space-1) 0;
  font-weight: 600;
  font-size: var(--td-text-sm);
  background: none;
  border: 0;
}
.ui-collapse__chevron {
  transition: transform var(--td-dur-fast) var(--td-ease);
}
.ui-collapse__chevron.is-open {
  transform: rotate(90deg);
}
.ui-collapse__panel {
  padding-top: var(--td-space-2);
}
</style>
