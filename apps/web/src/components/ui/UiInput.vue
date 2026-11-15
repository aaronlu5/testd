<template>
  <input
    class="td-control"
    :class="{ 'td-control--sm': size === 'sm' }"
    :value="modelValue"
    :aria-invalid="invalid ? 'true' : undefined"
    @input="onInput"
  />
</template>

<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    modelValue?: string | number
    size?: 'sm' | 'md'
    invalid?: boolean
    /** Emit numbers for type="number" inputs. */
    number?: boolean
  }>(),
  { modelValue: '', size: 'md' },
)
const emit = defineEmits<{ 'update:modelValue': [value: string | number] }>()

function onInput(event: Event) {
  const value = (event.target as HTMLInputElement).value
  emit('update:modelValue', props.number && value !== '' ? Number(value) : value)
}
</script>
