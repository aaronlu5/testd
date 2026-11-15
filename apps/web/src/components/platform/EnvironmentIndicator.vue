<template>
  <div class="env td-hide-sm" data-testid="environment-indicator">
    <Icon name="server" class="td-muted" />
    <label for="global-environment" class="td-sr-only">Active Environment</label>
    <select
      id="global-environment"
      class="td-control td-control--sm env__select"
      title="Active Environment: used to validate and run Tests and to list their targets"
      :value="environment.selectedId"
      data-testid="global-environment"
      @change="environment.select(($event.target as HTMLSelectElement).value)"
    >
      <option value="">{{ ENVIRONMENT_LABEL }}</option>
      <option v-for="env in environments ?? []" :key="env.id" :value="env.id">
        {{ env.name }} ({{ env.classification }})
      </option>
    </select>
    <RouterLink
      to="/environments"
      class="env__manage"
      title="Add or edit Environments"
      data-testid="manage-environments"
      >Manage</RouterLink
    >
  </div>
</template>

<script setup lang="ts">
import { watch } from 'vue'
import Icon from '~/components/ui/Icon.vue'
import { useEnvironments } from '~/api/queries'
import { ENVIRONMENT_LABEL } from '~/config/environment'
import { useEnvironmentStore } from '~/stores/environment'

const environment = useEnvironmentStore()
const { data: environments } = useEnvironments()

watch(
  environments,
  (list) => {
    if (list) environment.reconcile(list.map((env) => env.id))
  },
  { immediate: true },
)
</script>

<style scoped>
.env {
  display: flex;
  align-items: center;
  gap: var(--td-space-2);
}
.env__select {
  width: auto;
  min-width: 13rem;
  max-width: 20rem;
}
.env__manage {
  padding: 0 var(--td-space-1);
  font-size: var(--td-text-xs);
  font-weight: 600;
  white-space: nowrap;
}
</style>
