<template>
  <div class="td-grid" :style="{ '--td-gap': `var(--td-space-${gap})`, '--td-grid-min': minWidth }">
    <slot />
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ gap?: 1 | 2 | 3 | 4 | 5 | 6; minWidth?: string }>(), {
  gap: 4,
  minWidth: '16rem',
})
</script>
