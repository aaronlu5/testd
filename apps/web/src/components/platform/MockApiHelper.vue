<template>
  <div data-testid="mock-api-helper">
    <div class="td-row helper__head">
      <span class="helper__title">Mock API</span>
      <UiBadge v-if="modelValue.length > 0" variant="primary"
        >{{ modelValue.length }} selected</UiBadge
      >
      <RouterLink to="/mock-api" class="td-small helper__manage">Manage setups</RouterLink>
    </div>
    <p class="td-small td-muted helper__text">
      While this {{ level }} runs, the mock API server answers the paths of the selected setups.
      <template v-if="info"
        >Point the system under test at <code>{{ info.host }}</code
        >.</template
      >
    </p>

    <LoadingState v-if="isPending" label="Loading setups…" />
    <ProblemAlert v-else-if="error" :error="error" retryable @retry="() => refetch()" />
    <p v-else-if="setups.length === 0 && missing.length === 0" class="td-small td-muted td-mb-0">
      No setups yet. <RouterLink to="/mock-api/new">Create one</RouterLink>.
    </p>
    <div v-else class="td-stack" style="--td-gap: var(--td-space-2)">
      <div v-for="setup in setups" :key="setup.id" class="helper__option">
        <UiCheckbox
          :id="`mock-setup-${setup.id}`"
          :model-value="modelValue.includes(setup.id)"
          :data-testid="`mock-setup-${setup.id}`"
          @update:model-value="toggle(setup.id, $event as boolean)"
        >
          {{ setup.name }}
        </UiCheckbox>
        <RouterLink :to="`/mock-api/${setup.id}`" class="td-small">Edit</RouterLink>
      </div>
      <div v-for="id in missing" :key="id" class="helper__missing td-small">
        <UiCheckbox
          :id="`mock-missing-${id}`"
          :model-value="true"
          @update:model-value="toggle(id, false)"
        >
          A selected setup no longer exists (untick to remove)
        </UiCheckbox>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useAssetList, useMockApiInfo } from '~/api/queries'
import LoadingState from '~/components/platform/LoadingState.vue'
import ProblemAlert from '~/components/platform/ProblemAlert.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiCheckbox from '~/components/ui/UiCheckbox.vue'

const props = defineProps<{
  /** Ids of the selected setups. */
  modelValue: string[]
  /** Whether the helper is on a Test or on a Suite, for the wording. */
  level: 'Test' | 'Suite'
}>()
const emit = defineEmits<{ 'update:modelValue': [ids: string[]] }>()

const { data, error, isPending, refetch } = useAssetList('mockSetups')
const { data: info } = useMockApiInfo()
const setups = computed(() => data.value ?? [])
const missing = computed(() =>
  data.value ? props.modelValue.filter((id) => !data.value?.some((setup) => setup.id === id)) : [],
)

const toggle = (id: string, on: boolean) => {
  const without = props.modelValue.filter((existing) => existing !== id)
  emit('update:modelValue', on ? [...without, id] : without)
}
</script>

<style scoped>
.helper__head {
  margin-bottom: var(--td-space-2);
}
.helper__title {
  font-weight: 650;
}
.helper__manage {
  margin-left: auto;
}
.helper__text {
  margin: 0 0 var(--td-space-2);
}
.helper__option {
  display: flex;
  align-items: center;
  gap: var(--td-space-2);
}
.helper__missing {
  color: var(--td-danger);
}
</style>
