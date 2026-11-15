<template>
  <PageHeader title="Test Data" subtitle="Test Platform" />
  <AssetLibrary
    kind="testData"
    title="Test Data"
    base-path="/test-data"
    new-label="New Test Data"
    empty-hint="Test Data holds the JSON values a Test reads through {{testData…}}."
    deletable
  />
</template>

<script setup lang="ts">
import PageHeader from '~/components/PageHeader.vue'
import AssetLibrary from '~/components/platform/AssetLibrary.vue'
</script>
