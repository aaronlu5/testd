<template>
  <component
    :is="tag"
    v-bind="linkAttrs"
    class="ui-btn"
    :class="[
      `ui-btn--${tone}`,
      `ui-btn--${size}`,
      { 'is-outline': outline, 'is-loading': loading, 'is-block': block },
    ]"
    :disabled="tag === 'button' ? disabled || loading : undefined"
    :aria-disabled="tag !== 'button' && disabled ? 'true' : undefined"
    :aria-busy="loading ? 'true' : undefined"
  >
    <UiSpinner v-if="loading" size="sm" label="" />
    <slot />
  </component>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import UiSpinner from './UiSpinner.vue'

type Tone = 'primary' | 'secondary' | 'danger' | 'success' | 'warning' | 'info' | 'ghost' | 'link'

const props = withDefaults(
  defineProps<{
    /** Accepts `outline-<tone>` for an outlined variant. */
    variant?: Tone | `outline-${Exclude<Tone, 'ghost' | 'link'>}`
    size?: 'sm' | 'md' | 'lg'
    type?: 'button' | 'submit' | 'reset'
    to?: RouteLocationRaw
    href?: string
    disabled?: boolean
    loading?: boolean
    block?: boolean
  }>(),
  { variant: 'secondary', size: 'md', type: 'button', to: undefined, href: undefined },
)

const outline = computed(() => props.variant.startsWith('outline-'))
const tone = computed(() => props.variant.replace('outline-', ''))
const tag = computed(() => (props.to ? RouterLink : props.href ? 'a' : 'button'))
const linkAttrs = computed(() =>
  props.to ? { to: props.to } : props.href ? { href: props.href } : { type: props.type },
)
</script>

<style scoped>
.ui-btn {
  --btn-bg: var(--td-surface-3);
  --btn-fg: var(--td-text);
  --btn-bd: var(--td-border-strong);
  --btn-bg-hover: color-mix(in srgb, var(--td-surface-3) 80%, var(--td-text) 12%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--td-space-2);
  min-height: 2.25rem;
  padding: 0 var(--td-space-4);
  font-size: var(--td-text-sm);
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  color: var(--btn-fg);
  background: var(--btn-bg);
  border: 1px solid var(--btn-bd);
  border-radius: var(--td-radius-md);
  text-decoration: none;
  transition:
    background var(--td-dur-fast) var(--td-ease),
    border-color var(--td-dur-fast) var(--td-ease),
    transform var(--td-dur-fast) var(--td-ease);
}
.ui-btn:hover:not(:disabled):not([aria-disabled='true']) {
  background: var(--btn-bg-hover);
  color: var(--btn-fg);
}
.ui-btn:active:not(:disabled):not([aria-disabled='true']) {
  transform: translateY(1px);
}
.ui-btn:disabled,
.ui-btn[aria-disabled='true'] {
  opacity: 0.5;
  cursor: not-allowed;
  pointer-events: none;
}
.ui-btn--sm {
  min-height: 1.75rem;
  padding: 0 var(--td-space-3);
  font-size: var(--td-text-xs);
}
.ui-btn--lg {
  min-height: 2.75rem;
  padding: 0 var(--td-space-5);
  font-size: var(--td-text-md);
}
@media (pointer: coarse) {
  .ui-btn {
    min-height: 2.75rem;
  }
}
.is-block {
  display: flex;
  width: 100%;
}

.ui-btn--primary {
  --btn-bg: var(--td-accent);
  --btn-fg: var(--td-on-accent);
  --btn-bd: var(--td-accent);
  --btn-bg-hover: var(--td-accent-hover);
}
.ui-btn--danger {
  --btn-bg: var(--td-danger);
  --btn-fg: #fff;
  --btn-bd: var(--td-danger);
  --btn-bg-hover: color-mix(in srgb, var(--td-danger) 85%, #000);
}
.ui-btn--success {
  --btn-bg: var(--td-success);
  --btn-fg: #04140b;
  --btn-bd: var(--td-success);
  --btn-bg-hover: color-mix(in srgb, var(--td-success) 88%, #fff);
}
.ui-btn--warning {
  --btn-bg: var(--td-warning);
  --btn-fg: #1f1300;
  --btn-bd: var(--td-warning);
  --btn-bg-hover: color-mix(in srgb, var(--td-warning) 88%, #fff);
}
.ui-btn--info {
  --btn-bg: var(--td-info);
  --btn-fg: #02101f;
  --btn-bd: var(--td-info);
  --btn-bg-hover: color-mix(in srgb, var(--td-info) 88%, #fff);
}
.ui-btn--ghost {
  --btn-bg: transparent;
  --btn-bd: transparent;
  --btn-fg: var(--td-text-muted);
  --btn-bg-hover: var(--td-surface-3);
}
.ui-btn--ghost:hover:not(:disabled) {
  color: var(--td-text);
}
.ui-btn--link {
  --btn-bg: transparent;
  --btn-bd: transparent;
  --btn-fg: var(--td-accent-text);
  --btn-bg-hover: transparent;
  padding: 0 var(--td-space-1);
  text-decoration: underline;
  text-underline-offset: 0.2em;
}

/* Outline: tone colours the border and text, background stays quiet */
.is-outline {
  --btn-bg: transparent;
}
.is-outline.ui-btn--primary {
  --btn-fg: var(--td-accent-text);
  --btn-bd: color-mix(in srgb, var(--td-accent) 60%, transparent);
  --btn-bg-hover: var(--td-accent-soft);
}
.is-outline.ui-btn--secondary {
  --btn-bg-hover: var(--td-surface-3);
}
.is-outline.ui-btn--danger {
  --btn-fg: var(--td-danger);
  --btn-bd: color-mix(in srgb, var(--td-danger) 55%, transparent);
  --btn-bg-hover: color-mix(in srgb, var(--td-danger) 12%, transparent);
}
.is-outline.ui-btn--success {
  --btn-fg: var(--td-success);
  --btn-bd: color-mix(in srgb, var(--td-success) 55%, transparent);
  --btn-bg-hover: color-mix(in srgb, var(--td-success) 12%, transparent);
}
.is-outline.ui-btn--warning {
  --btn-fg: var(--td-warning);
  --btn-bd: color-mix(in srgb, var(--td-warning) 55%, transparent);
  --btn-bg-hover: color-mix(in srgb, var(--td-warning) 12%, transparent);
}
.is-outline.ui-btn--info {
  --btn-fg: var(--td-info);
  --btn-bd: color-mix(in srgb, var(--td-info) 55%, transparent);
  --btn-bg-hover: color-mix(in srgb, var(--td-info) 12%, transparent);
}
</style>
