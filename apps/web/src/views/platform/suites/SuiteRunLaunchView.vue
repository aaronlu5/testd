<template>
  <PageHeader title="Run a Suite" subtitle="Suite Runs" subtitle-url="/suite-runs" />

  <UiCard data-testid="suite-run-launcher">
    <LoadingState v-if="pending" label="Loading…" />
    <ProblemAlert :error="listError" retryable @retry="refetchAll" />

    <form v-if="!pending" class="launch" novalidate @submit.prevent="submit">
      <div class="td-form-grid" style="--td-col: 18rem">
        <div class="td-field">
          <label for="sr-suite" class="td-label">Suite</label>
          <select
            id="sr-suite"
            v-model="suiteId"
            class="td-control"
            :aria-invalid="touched && !suiteId"
          >
            <option value="">Select a Suite</option>
            <option v-for="suite in suites ?? []" :key="suite.id" :value="suite.id">
              {{ suite.name }}
            </option>
          </select>
        </div>
        <div class="td-field">
          <label for="sr-env" class="td-label">Environment</label>
          <select
            id="sr-env"
            v-model="environmentId"
            class="td-control"
            :aria-invalid="touched && !environmentId"
          >
            <option value="">Select an Environment</option>
            <option v-for="env in environments ?? []" :key="env.id" :value="env.id">
              {{ env.name }} ({{ env.classification }})
            </option>
          </select>
        </div>

        <div class="td-field">
          <label for="sr-concurrency" class="td-label">Concurrency</label>
          <input
            id="sr-concurrency"
            v-model="concurrencyText"
            class="td-control"
            type="number"
            inputmode="numeric"
            :min="bounds.min"
            :max="bounds.max"
            step="1"
            :disabled="!environment || !bounds.editable"
            :placeholder="bounds.editable ? 'Suite default' : '1'"
            aria-describedby="sr-concurrency-help"
            data-testid="concurrency-input"
          />
          <div id="sr-concurrency-help" class="td-hint" data-testid="concurrency-help">
            <template v-if="!environment"
              >Choose an Environment to see how many items can run at once.</template
            >
            <template v-else-if="bounds.editable">
              This Environment allows up to {{ bounds.max }} Suite items at once. Leave blank to use
              the Suite's own setting (never above that limit).
            </template>
            <template v-else>
              This Environment runs Suite items one after another. Higher concurrency needs an
              explicit limit in the Environment configuration.
            </template>
          </div>
        </div>
      </div>

      <UiAlert v-if="clientError" variant="warning" data-testid="launch-error">
        {{ clientError }}
      </UiAlert>
      <ProblemAlert :error="create.error.value" />

      <div class="td-row">
        <UiButton
          type="submit"
          variant="primary"
          :disabled="create.isPending.value"
          data-testid="launch-suite-run"
        >
          {{ create.isPending.value ? 'Starting…' : 'Run Suite' }}
        </UiButton>
        <UiButton to="/suite-runs" variant="outline-secondary">Cancel</UiButton>
      </div>
    </form>
  </UiCard>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import UiAlert from '~/components/ui/UiAlert.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiCard from '~/components/ui/UiCard.vue'
import PageHeader from '~/components/PageHeader.vue'
import LoadingState from '~/components/platform/LoadingState.vue'
import ProblemAlert from '~/components/platform/ProblemAlert.vue'
import { buildSuiteRunRequest, concurrencyBounds } from '~/components/platform/suite-launch'
import { useAssetList, useCreateSuiteRun, useEnvironments } from '~/api/queries'
import { useEnvironmentStore } from '~/stores/environment'

const route = useRoute()
const router = useRouter()

const suitesQuery = useAssetList('suites')
const envQuery = useEnvironments()
const suites = computed(() => suitesQuery.data.value)
const environments = computed(() => envQuery.data.value)
const pending = computed(() => suitesQuery.isPending.value || envQuery.isPending.value)
const listError = computed(() => suitesQuery.error.value ?? envQuery.error.value)
const refetchAll = () => {
  void suitesQuery.refetch()
  void envQuery.refetch()
}

const suiteId = ref((route.query.suiteId as string | undefined) ?? '')
const environmentStore = useEnvironmentStore()
// The same Environment as the top bar: changing it here changes it everywhere.
const environmentId = computed({
  get: () => environmentStore.selectedId,
  set: (id: string) => environmentStore.select(id),
})
const concurrencyText = ref('')
const touched = ref(false)
const clientError = ref('')

const environment = computed(() =>
  (environments.value ?? []).find((e) => e.id === environmentId.value),
)
const bounds = computed(() => concurrencyBounds(environment.value))

const create = useCreateSuiteRun()
const submit = async () => {
  touched.value = true
  const request = buildSuiteRunRequest({
    suiteId: suiteId.value,
    environment: environment.value,
    // A number input yields a number once the user types, so always hand over text.
    concurrencyText: bounds.value.editable ? String(concurrencyText.value ?? '') : '',
  })
  if ('error' in request) {
    clientError.value = request.error
    return
  }
  clientError.value = ''
  const created = await create.mutateAsync(request.body)
  await router.push(`/suite-runs/${created.id}`)
}
</script>

<style scoped>
.launch {
  display: flex;
  flex-direction: column;
  gap: var(--td-space-4);
}
</style>
