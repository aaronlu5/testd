<template>
  <span class="ui-spinner" :class="`ui-spinner--${size}`" role="status">
    <span class="ui-spinner__ring" aria-hidden="true"></span>
    <span v-if="label" class="td-sr-only">{{ label }}</span>
  </span>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: 'sm' | 'md' | 'lg'; label?: string }>(), {
  size: 'md',
  label: 'Loading',
})
</script>

<style scoped>
.ui-spinner {
  display: inline-flex;
}
.ui-spinner__ring {
  width: 1.25rem;
  height: 1.25rem;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, currentColor 25%, transparent);
  border-top-color: currentColor;
  animation: ui-spin 0.7s linear infinite;
}
.ui-spinner--sm .ui-spinner__ring {
  width: 0.875rem;
  height: 0.875rem;
}
.ui-spinner--lg .ui-spinner__ring {
  width: 2rem;
  height: 2rem;
  border-width: 3px;
}
@keyframes ui-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
