<template>
  <label class="ui-switch" :class="{ 'is-disabled': disabled }">
    <input
      type="checkbox"
      role="switch"
      class="ui-switch__input"
      :checked="modelValue"
      :disabled="disabled"
      @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
    />
    <span class="ui-switch__track" aria-hidden="true"><span class="ui-switch__thumb"></span></span>
    <span v-if="$slots.default" class="ui-switch__label"><slot /></span>
  </label>
</template>

<script setup lang="ts">
defineProps<{ modelValue?: boolean; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
</script>

<style scoped>
.ui-switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--td-space-2);
  font-size: var(--td-text-sm);
  cursor: pointer;
}
.ui-switch.is-disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.ui-switch__input {
  position: absolute;
  opacity: 0;
  width: 2.25rem;
  height: 1.25rem;
  margin: 0;
  cursor: inherit;
}
.ui-switch__track {
  flex: none;
  width: 2.25rem;
  height: 1.25rem;
  padding: 2px;
  background: var(--td-surface-3);
  border: 1px solid var(--td-border-strong);
  border-radius: var(--td-radius-pill);
  transition: background var(--td-dur-fast) var(--td-ease);
}
.ui-switch__thumb {
  display: block;
  width: 0.875rem;
  height: 0.875rem;
  background: var(--td-text-muted);
  border-radius: 50%;
  transition:
    transform var(--td-dur-fast) var(--td-ease),
    background var(--td-dur-fast) var(--td-ease);
}
.ui-switch__input:checked + .ui-switch__track {
  background: var(--td-accent);
  border-color: var(--td-accent);
}
.ui-switch__input:checked + .ui-switch__track .ui-switch__thumb {
  transform: translateX(1rem);
  background: var(--td-on-accent);
}
.ui-switch__input:focus-visible + .ui-switch__track {
  outline: 2px solid var(--td-focus);
  outline-offset: 2px;
}
</style>
