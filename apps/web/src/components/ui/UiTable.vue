<template>
  <div class="td-table-wrap" tabindex="0" role="region" :aria-label="label">
    <table class="td-table">
      <slot />
    </table>
  </div>
</template>

<script setup lang="ts">
defineProps<{ label?: string }>()
</script>
