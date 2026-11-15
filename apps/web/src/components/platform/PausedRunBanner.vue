<template>
  <div class="paused" role="status" aria-live="polite" data-testid="paused-banner">
    <span class="paused__icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
        <rect x="6" y="5" width="4" height="14" rx="1" />
        <rect x="14" y="5" width="4" height="14" rx="1" />
      </svg>
    </span>
    <div class="paused__text">
      <div class="paused__title" data-testid="paused-title">
        Paused at breakpoint “{{ breakpointName }}”
      </div>
      <div class="td-small">
        <template v-if="nextName">
          Next Step: <strong>{{ nextName }}</strong
          >. It has not started.
        </template>
        <template v-else>No Step follows; resuming finishes the Run.</template>
        <span v-if="pausedAt"> Paused {{ formatTime(pausedAt) }}.</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { formatTime } from '~/components/platform/format'

defineProps<{ breakpointName: string; nextName?: string; pausedAt?: string }>()
</script>

<style scoped>
.paused {
  display: flex;
  align-items: center;
  gap: var(--td-space-4);
  margin-bottom: var(--td-space-4);
  padding: var(--td-space-3) var(--td-space-4);
  background: color-mix(in srgb, var(--td-paused) 12%, var(--td-surface));
  border: 1px solid color-mix(in srgb, var(--td-paused) 55%, transparent);
  border-left-width: 4px;
  border-radius: var(--td-radius-md);
}
.paused__icon {
  display: grid;
  place-items: center;
  width: 2.5rem;
  height: 2.5rem;
  flex: none;
  color: var(--td-paused);
  background: color-mix(in srgb, var(--td-paused) 16%, transparent);
  border-radius: 50%;
}
.paused__title {
  font-size: var(--td-text-lg);
  font-weight: 650;
}
</style>
