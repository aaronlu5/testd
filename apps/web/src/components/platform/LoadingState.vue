<template>
  <div class="loading" role="status">
    <UiSpinner size="sm" label="" />
    <span>{{ label }}</span>
  </div>
</template>

<script setup lang="ts">
import UiSpinner from '~/components/ui/UiSpinner.vue'

withDefaults(defineProps<{ label?: string }>(), { label: 'Loading…' })
</script>

<style scoped>
.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--td-space-2);
  padding: var(--td-space-5) 0;
  color: var(--td-text-muted);
}
</style>
