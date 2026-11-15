<template>
  <PageHeader title="Mock API" subtitle="Helpers" />

  <div class="intro">
    <MockApiAddress />
    <p class="td-small td-muted intro__text">
      A <strong>setup</strong> is a set of rules: a path pattern (a regular expression) mapped to a
      status code and a JSON body. Add setups to a Test or a Suite from its editor; they are saved
      with it and served automatically while it runs.
    </p>
  </div>

  <AssetLibrary
    kind="mockSetups"
    title="Mock API setups"
    base-path="/mock-api"
    new-label="New setup"
    empty-hint="A setup maps request paths to the responses the mock API server returns."
    deletable
  />
</template>

<script setup lang="ts">
import PageHeader from '~/components/PageHeader.vue'
import AssetLibrary from '~/components/platform/AssetLibrary.vue'
import MockApiAddress from '~/components/platform/MockApiAddress.vue'
</script>

<style scoped>
.intro {
  margin-bottom: var(--td-space-4);
}
.intro__text {
  margin: var(--td-space-2) 0 0;
}
</style>
