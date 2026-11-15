<template>
  <component :is="as" class="ui-card" :class="{ 'is-flush': flush, 'is-interactive': interactive }">
    <header v-if="title || $slots.header || $slots.actions" class="ui-card__header">
      <slot name="header">
        <h2 class="ui-card__title">{{ title }}</h2>
      </slot>
      <div v-if="$slots.actions" class="ui-card__actions"><slot name="actions" /></div>
    </header>
    <div class="ui-card__body"><slot /></div>
    <footer v-if="$slots.footer" class="ui-card__footer"><slot name="footer" /></footer>
  </component>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    title?: string
    as?: string
    /** Remove body padding (tables, lists, canvases). */
    flush?: boolean
    interactive?: boolean
  }>(),
  { title: undefined, as: 'section' },
)
</script>

<style scoped>
.ui-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--td-surface);
  border: 1px solid var(--td-border);
  border-radius: var(--td-radius-lg);
  box-shadow: var(--td-shadow-1);
}
.is-interactive {
  transition:
    border-color var(--td-dur-fast) var(--td-ease),
    background var(--td-dur-fast) var(--td-ease);
}
.is-interactive:hover {
  border-color: var(--td-border-strong);
  background: var(--td-surface-2);
}
.ui-card__header {
  display: flex;
  align-items: center;
  gap: var(--td-space-3);
  padding: var(--td-space-3) var(--td-space-4);
  border-bottom: 1px solid var(--td-border);
}
.ui-card__title {
  margin: 0;
  font-size: var(--td-text-md);
}
.ui-card__actions {
  margin-left: auto;
  display: flex;
  gap: var(--td-space-2);
  align-items: center;
}
.ui-card__body {
  flex: 1 1 auto;
  min-width: 0;
  padding: var(--td-space-4);
}
.is-flush > .ui-card__body {
  padding: 0;
}
.ui-card__footer {
  padding: var(--td-space-3) var(--td-space-4);
  border-top: 1px solid var(--td-border);
  background: var(--td-surface-2);
  border-radius: 0 0 var(--td-radius-lg) var(--td-radius-lg);
}
</style>
