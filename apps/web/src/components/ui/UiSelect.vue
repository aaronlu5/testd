<template>
  <select
    class="td-control"
    :class="{ 'td-control--sm': size === 'sm' }"
    :value="modelValue"
    :aria-invalid="invalid ? 'true' : undefined"
    @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
  >
    <option
      v-for="option in options"
      :key="option.value"
      :value="option.value"
      :disabled="option.disabled"
    >
      {{ option.label }}
    </option>
    <slot />
  </select>
</template>

<script setup lang="ts">
export interface UiSelectOption {
  value: string
  label: string
  disabled?: boolean
}

withDefaults(
  defineProps<{
    modelValue?: string
    options?: UiSelectOption[]
    size?: 'sm' | 'md'
    invalid?: boolean
  }>(),
  { modelValue: '', options: () => [], size: 'md' },
)
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
</script>
