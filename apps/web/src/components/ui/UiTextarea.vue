<template>
  <textarea
    class="td-control"
    :class="{ 'td-control--sm': size === 'sm' }"
    :value="modelValue"
    :aria-invalid="invalid ? 'true' : undefined"
    @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
  ></textarea>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ modelValue?: string; size?: 'sm' | 'md'; invalid?: boolean }>(), {
  modelValue: '',
  size: 'md',
})
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
</script>
