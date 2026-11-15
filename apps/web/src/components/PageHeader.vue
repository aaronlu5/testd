<template>
  <header class="page-header">
    <div class="page-header__text">
      <p v-if="subtitle" class="page-header__crumb">
        <RouterLink v-if="subtitleUrl" :to="subtitleUrl">{{ subtitle }}</RouterLink>
        <template v-else>{{ subtitle }}</template>
      </p>
      <h1 class="page-header__title">{{ title }}</h1>
    </div>
    <div v-if="$slots.actions" class="page-header__actions"><slot name="actions" /></div>
  </header>
</template>

<script setup lang="ts">
/** Page title block. Replaces the old PageBreadcrumb: same `title` / `subtitle` props. */
defineProps<{ title: string; subtitle?: string; subtitleUrl?: string }>()
</script>

<style scoped>
.page-header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--td-space-3);
  margin-bottom: var(--td-space-5);
}
.page-header__crumb {
  margin: 0 0 0.125rem;
  font-size: var(--td-text-xs);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--td-accent-text);
}
.page-header__crumb a {
  color: inherit;
  text-decoration: none;
}
.page-header__crumb a:hover {
  text-decoration: underline;
}
.page-header__title {
  margin: 0;
}
.page-header__actions {
  display: flex;
  gap: var(--td-space-2);
  flex-wrap: wrap;
}
</style>
