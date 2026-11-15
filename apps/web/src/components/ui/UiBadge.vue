<template>
  <span class="ui-badge" :class="[`ui-badge--${variant}`, { 'is-dot': dot, 'is-pulse': pulse }]">
    <span v-if="dot" class="ui-badge__dot" aria-hidden="true"></span>
    <slot />
  </span>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?:
      | 'neutral'
      | 'primary'
      | 'success'
      | 'warning'
      | 'danger'
      | 'info'
      | 'running'
      | 'paused'
    dot?: boolean
    /** Animate the dot (work in progress). */
    pulse?: boolean
  }>(),
  { variant: 'neutral' },
)
</script>

<style scoped>
.ui-badge {
  --b: var(--td-text-muted);
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.125rem 0.5rem;
  font-size: var(--td-text-xs);
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
  color: var(--b);
  background: color-mix(in srgb, var(--b) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--b) 32%, transparent);
  border-radius: var(--td-radius-pill);
}
.ui-badge__dot {
  width: 0.4375rem;
  height: 0.4375rem;
  border-radius: 50%;
  background: currentColor;
}
.ui-badge--primary {
  --b: var(--td-accent-text);
}
.ui-badge--success {
  --b: var(--td-success);
}
.ui-badge--warning {
  --b: var(--td-warning);
}
.ui-badge--danger {
  --b: var(--td-danger);
}
.ui-badge--info {
  --b: var(--td-info);
}
.ui-badge--running {
  --b: var(--td-running);
}
.ui-badge--paused {
  --b: var(--td-paused);
}
.is-pulse .ui-badge__dot {
  animation: ui-badge-pulse 1.2s ease-in-out infinite;
}
@keyframes ui-badge-pulse {
  50% {
    opacity: 0.3;
  }
}
</style>
