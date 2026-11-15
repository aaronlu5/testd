<template>
  <button type="button" class="tb-toggle" :aria-label="label" :title="title ?? label">
    <slot />
    <slot name="overlay" />
  </button>
</template>

<script setup lang="ts">
/** Icon button for the top bar widgets (monitor and inspector panels). */
defineProps<{ label: string; title?: string }>()
</script>

<style scoped>
.tb-toggle {
  position: relative;
  display: grid;
  place-items: center;
  width: 2.25rem;
  height: 2.25rem;
  color: var(--td-text-muted);
  background: transparent;
  border: 0;
  border-radius: var(--td-radius-md);
}
.tb-toggle:hover {
  color: var(--td-text);
  background: var(--td-surface-3);
}
</style>
