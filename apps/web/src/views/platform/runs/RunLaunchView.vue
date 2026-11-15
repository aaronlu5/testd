<template>
  <PageHeader title="Run a Test" subtitle="Runs" subtitle-url="/runs" />

  <UiCard data-testid="run-launcher">
    <LoadingState v-if="listsPending" label="Loading…" />
    <ProblemAlert :error="listsError" retryable @retry="refetchAll" />

    <form v-if="!listsPending" class="launch" novalidate @submit.prevent="submit">
      <div class="launch__grid">
        <div class="td-field launch__wide">
          <label for="run-test" class="td-label">Test</label>
          <select
            id="run-test"
            v-model="testId"
            class="td-control"
            :aria-invalid="touched && !testId"
          >
            <option value="">Select a Test</option>
            <option v-for="test in tests ?? []" :key="test.id" :value="test.id">
              {{ test.name }}
            </option>
          </select>
        </div>
        <div class="td-field">
          <label for="run-test-version" class="td-label">Test version</label>
          <select
            id="run-test-version"
            v-model="testVersion"
            class="td-control"
            :disabled="!testId"
          >
            <option value="">Latest</option>
            <option v-for="v in testVersions ?? []" :key="v.version" :value="String(v.version)">
              v{{ v.version }} · {{ new Date(v.createdAt).toLocaleString() }}
            </option>
          </select>
        </div>

        <div class="td-field launch__wide">
          <label for="run-data" class="td-label">Test Data</label>
          <select
            id="run-data"
            v-model="dataSetId"
            class="td-control"
            :aria-invalid="touched && !dataSetId"
          >
            <option value="">Select Test Data</option>
            <option v-for="data in dataSets ?? []" :key="data.id" :value="data.id">
              {{ data.name }}
            </option>
          </select>
        </div>
        <div class="td-field">
          <label for="run-data-version" class="td-label">Test Data version</label>
          <select
            id="run-data-version"
            v-model="dataVersion"
            class="td-control"
            :disabled="!dataSetId"
          >
            <option value="">Latest</option>
            <option v-for="v in dataVersions ?? []" :key="v.version" :value="String(v.version)">
              v{{ v.version }} · {{ new Date(v.createdAt).toLocaleString() }}
            </option>
          </select>
        </div>

        <div class="td-field launch__wide">
          <label for="run-env" class="td-label">Environment</label>
          <select
            id="run-env"
            v-model="environmentId"
            class="td-control"
            :aria-invalid="touched && !environmentId"
          >
            <option value="">Select an Environment</option>
            <option v-for="env in environments ?? []" :key="env.id" :value="env.id">
              {{ env.name }} ({{ env.classification }})
            </option>
          </select>
          <div v-if="selectedEnvironment" class="td-hint">
            Targets: {{ selectedEnvironment.targets.map((t) => t.name).join(', ') || 'none' }}
          </div>
        </div>
      </div>

      <UiAlert v-if="touched && missing.length > 0" variant="warning" data-testid="launch-missing">
        Select {{ missing.join(', ') }} before running.
      </UiAlert>

      <fieldset v-if="declaredVariables.length > 0" class="launch__vars">
        <legend>Variable overrides (optional)</legend>
        <p class="td-small td-muted">
          Override a Test variable for this Run only. Values are sent with the request and stored
          with the Run, so never enter secrets.
        </p>
        <div v-for="name in declaredVariables" :key="name" class="launch__var">
          <label :for="`override-${name}`" class="td-mono launch__var-name">{{ name }}</label>
          <div class="td-field">
            <input
              :id="`override-${name}`"
              v-model="overrideText[name]"
              class="td-control"
              autocomplete="off"
              :placeholder="`Default: ${preview(name)}`"
              :aria-invalid="Boolean(overrides.errors[name])"
            />
            <div v-if="overrides.errors[name]" class="td-error" role="alert">
              {{ overrides.errors[name] }}
            </div>
          </div>
        </div>
      </fieldset>

      <ProblemAlert :error="launchError" />

      <div class="td-row">
        <UiButton type="submit" variant="primary" :disabled="launching" data-testid="launch-run">
          {{ launching ? 'Starting…' : 'Run' }}
        </UiButton>
        <UiButton to="/runs" variant="outline-secondary">Cancel</UiButton>
      </div>
    </form>
  </UiCard>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import UiAlert from '~/components/ui/UiAlert.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiCard from '~/components/ui/UiCard.vue'
import PageHeader from '~/components/PageHeader.vue'
import LoadingState from '~/components/platform/LoadingState.vue'
import ProblemAlert from '~/components/platform/ProblemAlert.vue'
import {
  useAsset,
  useAssetList,
  useAssetVersions,
  useCreateRun,
  useEnvironments,
} from '~/api/queries'
import { useEnvironmentStore } from '~/stores/environment'
import type { TestDefinition } from '~/api/types'
import { buildOverrides } from '~/components/platform/launch'

const route = useRoute()
const router = useRouter()

const testId = ref(String(route.query.testId ?? ''))
const testVersion = ref('')
const dataSetId = ref(String(route.query.dataSetId ?? ''))
const dataVersion = ref('')
const environmentStore = useEnvironmentStore()
// The same Environment as the top bar: changing it here changes it everywhere.
const environmentId = computed({
  get: () => environmentStore.selectedId,
  set: (id: string) => environmentStore.select(id),
})
const overrideText = reactive<Record<string, string>>({})
const touched = ref(false)

const testsQuery = useAssetList('tests')
const dataQuery = useAssetList('testData')
const envQuery = useEnvironments()
const tests = computed(() => testsQuery.data.value)
const dataSets = computed(() => dataQuery.data.value)
const environments = computed(() => envQuery.data.value)

const listsPending = computed(
  () => testsQuery.isPending.value || dataQuery.isPending.value || envQuery.isPending.value,
)
const listsError = computed(
  () => testsQuery.error.value ?? dataQuery.error.value ?? envQuery.error.value,
)
const refetchAll = () => {
  void testsQuery.refetch()
  void dataQuery.refetch()
  void envQuery.refetch()
}

const { data: testVersions } = useAssetVersions('tests', () => testId.value || undefined)
const { data: dataVersions } = useAssetVersions('testData', () => dataSetId.value || undefined)

const selectedVersion = computed(() => (testVersion.value ? Number(testVersion.value) : undefined))
const { data: selectedTest } = useAsset(
  'tests',
  () => testId.value || undefined,
  () => selectedVersion.value,
)
const variables = computed(
  () => (selectedTest.value as TestDefinition | undefined)?.variables ?? {},
)
const declaredVariables = computed(() => Object.keys(variables.value))
const preview = (name: string) => {
  const text = JSON.stringify(variables.value[name])
  return text.length > 40 ? `${text.slice(0, 37)}…` : text
}

const selectedEnvironment = computed(() =>
  (environments.value ?? []).find((env) => env.id === environmentId.value),
)

// A different Test or version has different variables; start from a clean slate.
watch([testId, testVersion], () => {
  for (const key of Object.keys(overrideText)) delete overrideText[key]
})
watch(testId, () => (testVersion.value = ''))
watch(dataSetId, () => (dataVersion.value = ''))

const overrides = computed(() => buildOverrides(declaredVariables.value, overrideText))
const missing = computed(() => [
  ...(testId.value ? [] : ['a Test']),
  ...(dataSetId.value ? [] : ['Test Data']),
  ...(environmentId.value ? [] : ['an Environment']),
])

const create = useCreateRun()
const launching = computed(() => create.isPending.value)
const launchError = computed(() => create.error.value)

const submit = async () => {
  touched.value = true
  create.reset()
  if (missing.value.length > 0 || Object.keys(overrides.value.errors).length > 0) return
  try {
    const run = await create.mutateAsync({
      testId: testId.value,
      ...(testVersion.value ? { testVersion: Number(testVersion.value) } : {}),
      dataSetId: dataSetId.value,
      ...(dataVersion.value ? { dataSetVersion: Number(dataVersion.value) } : {}),
      environmentId: environmentId.value,
      ...(Object.keys(overrides.value.value).length > 0
        ? { variableOverrides: overrides.value.value }
        : {}),
    })
    await router.push(`/runs/${run.id}`)
  } catch {
    // The error is rendered from the mutation state.
  }
}
</script>

<style scoped>
.launch {
  display: flex;
  flex-direction: column;
  gap: var(--td-space-4);
}
.launch__grid {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: var(--td-space-4);
}
.launch__grid > .td-field {
  grid-column: span 4;
}
.launch__grid > .launch__wide {
  grid-column: span 8;
}
@media (max-width: 47.99rem) {
  .launch__grid > .td-field,
  .launch__grid > .launch__wide {
    grid-column: 1 / -1;
  }
}
.launch__vars {
  min-width: 0;
  margin: 0;
  padding: var(--td-space-3) var(--td-space-4) var(--td-space-4);
  border: 1px solid var(--td-border);
  border-radius: var(--td-radius-md);
}
.launch__vars legend {
  padding: 0 var(--td-space-2);
  font-size: var(--td-text-sm);
  font-weight: 650;
}
.launch__var {
  display: grid;
  grid-template-columns: minmax(7rem, 1fr) minmax(0, 3fr);
  align-items: start;
  gap: var(--td-space-3);
  margin-bottom: var(--td-space-2);
}
.launch__var-name {
  padding-top: 0.5rem;
  font-size: var(--td-text-sm);
}
@media (max-width: 47.99rem) {
  .launch__var {
    grid-template-columns: 1fr;
    gap: var(--td-space-1);
  }
  .launch__var-name {
    padding-top: 0;
  }
}
</style>
