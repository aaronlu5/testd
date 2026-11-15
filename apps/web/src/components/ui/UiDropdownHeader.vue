<template>
  <div class="ui-dd-header" role="presentation"><slot /></div>
</template>

<style scoped>
.ui-dd-header {
  padding: 0.375rem var(--td-space-3);
  font-size: var(--td-text-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--td-text-faint);
}
</style>
