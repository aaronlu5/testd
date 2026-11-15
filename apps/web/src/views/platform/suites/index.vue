<template>
  <PageHeader title="Suites" subtitle="Test Platform" />
  <div class="td-row suite-links" data-testid="suite-run-links">
    <UiButton to="/suite-runs/new" variant="primary">Run a Suite…</UiButton>
    <UiButton to="/suite-runs" variant="outline-secondary">Suite Runs</UiButton>
  </div>
  <AssetLibrary
    kind="suites"
    title="Suites"
    base-path="/suites"
    new-label="New Suite"
    empty-hint="A Suite is an ordered list of Test and Test Data pairs."
  />
</template>

<script setup lang="ts">
import PageHeader from '~/components/PageHeader.vue'
import AssetLibrary from '~/components/platform/AssetLibrary.vue'
import UiButton from '~/components/ui/UiButton.vue'
</script>

<style scoped>
.suite-links {
  margin-bottom: var(--td-space-4);
}
</style>
