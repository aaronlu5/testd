<template>
  <div class="bp" data-testid="breakpoint-node">
    <span class="bp__icon" aria-hidden="true">{{ enabled ? '⏸' : '⏭' }}</span>
    <div class="bp__text">
      <div class="bp__name">{{ name }}</div>
      <div class="bp__sub">Breakpoint · {{ enabled ? 'pauses the Run' : 'disabled, skipped' }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ name: string; enabled: boolean }>()
</script>

<style scoped>
.bp {
  display: flex;
  align-items: center;
  gap: var(--td-space-2);
}
.bp__icon {
  font-size: 1.25rem;
  line-height: 1;
}
.bp__text {
  min-width: 0;
}
.bp__name,
.bp__sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bp__name {
  font-weight: 650;
}
.bp__sub {
  font-size: var(--td-text-xs);
  color: var(--td-text-muted);
}
</style>
