<template>
  <component
    :is="as"
    :class="row ? 'td-row' : 'td-stack'"
    :style="{ '--td-gap': `var(--td-space-${gap})` }"
  >
    <slot />
  </component>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ gap?: 1 | 2 | 3 | 4 | 5 | 6; row?: boolean; as?: string }>(), {
  gap: 4,
  as: 'div',
})
</script>
