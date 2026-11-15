<template>
  <AppErrorBoundary>
    <RouterView />
  </AppErrorBoundary>
</template>

<script setup lang="ts">
import { RouterView } from 'vue-router'
import AppErrorBoundary from '~/components/platform/AppErrorBoundary.vue'
import { useLayout } from '~/stores/layout'

useLayout().init()
</script>
