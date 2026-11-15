<template>
  <AppShell>
    <template #widgets>
      <EnvironmentIndicator />
      <MockApiMonitor />
      <ServiceBusInspector />
    </template>
    <RouterView />
  </AppShell>
</template>

<script setup lang="ts">
import { RouterView } from 'vue-router'
import EnvironmentIndicator from '~/components/platform/EnvironmentIndicator.vue'
import MockApiMonitor from '~/components/platform/MockApiMonitor.vue'
import ServiceBusInspector from '~/components/platform/inspector/ServiceBusInspector.vue'
import AppShell from './AppShell.vue'
</script>
