<template>
  <PageHeader title="Tests" subtitle="Test Platform" />
  <AssetLibrary
    kind="tests"
    title="Tests"
    base-path="/tests"
    new-label="New Test"
    empty-hint="Create a Test to chain Steps into a repeatable flow."
    runnable
    deletable
  />
</template>

<script setup lang="ts">
import PageHeader from '~/components/PageHeader.vue'
import AssetLibrary from '~/components/platform/AssetLibrary.vue'
</script>
