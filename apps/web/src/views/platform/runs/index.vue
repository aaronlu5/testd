<template>
  <PageHeader title="Runs" subtitle="Test Platform" />

  <UiCard flush data-testid="run-history">
    <template #header>
      <div class="rv__bar">
        <div class="rv__filters">
          <div class="td-field">
            <label for="filter-status" class="td-hint">Status</label>
            <select id="filter-status" v-model="status" class="td-control">
              <option value="">All</option>
              <option v-for="value in RUN_STATUS_VALUES" :key="value" :value="value">
                {{ value }}
              </option>
            </select>
          </div>
          <div class="td-field">
            <label for="filter-test" class="td-hint">Test</label>
            <select id="filter-test" v-model="testId" class="td-control">
              <option value="">All</option>
              <option v-for="test in tests ?? []" :key="test.id" :value="test.id">
                {{ test.name }}
              </option>
            </select>
          </div>
          <div class="td-field">
            <label for="filter-env" class="td-hint">Environment</label>
            <select id="filter-env" v-model="environmentId" class="td-control">
              <option value="">All</option>
              <option v-for="env in environments ?? []" :key="env.id" :value="env.id">
                {{ env.name }}
              </option>
            </select>
          </div>
        </div>
        <UiButton to="/runs/new" variant="primary" data-testid="new-run">
          <Icon name="player-play" :size="16" /> Run a Test
        </UiButton>
      </div>
    </template>

    <div class="rv__notices">
      <ProblemAlert :error="error" retryable @retry="() => refetch()" />
      <ProblemAlert :error="actionError" />
    </div>

    <LoadingState v-if="isPending" label="Loading Runs…" />
    <EmptyState
      v-else-if="!isError && runs.length === 0"
      :title="filtered ? 'No Runs match these filters' : 'No Runs yet'"
      :description="
        filtered ? 'Clear a filter to see more.' : 'Run a Test to see its results here.'
      "
    />

    <div
      v-else-if="runs.length > 0"
      class="rv__table"
      tabindex="0"
      role="region"
      aria-label="Runs (scrollable)"
    >
      <table class="td-table">
        <caption class="td-sr-only">
          Runs
        </caption>
        <thead>
          <tr>
            <th scope="col">Test</th>
            <th scope="col">Status</th>
            <th scope="col">Environment</th>
            <th scope="col">Requested</th>
            <th scope="col">Duration</th>
            <th scope="col" class="td-cell-actions">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="run in runs" :key="run.id" data-testid="run-row">
            <td>
              <RouterLink :to="`/runs/${run.id}`" class="rv__name">{{ testName(run) }}</RouterLink>
              <div class="td-muted td-small">
                v{{ run.test?.version }}<span v-if="run.rerunOfRunId"> · rerun</span>
              </div>
            </td>
            <td><StatusBadge :status="run.status" /></td>
            <td>{{ run.environmentId }}</td>
            <td>{{ formatTime(run.requestedAt) }}</td>
            <td>{{ formatDuration(runDurationMs(run)) }}</td>
            <td class="td-cell-actions">
              <UiButton
                :to="`/runs/${run.id}`"
                size="sm"
                variant="outline-primary"
                :aria-label="`Inspect Run ${run.id.slice(0, 8)}`"
                >Inspect</UiButton
              >
              <UiButton
                v-if="isActiveRunStatus(run.status)"
                size="sm"
                variant="outline-danger"
                :disabled="run.status === 'Cancelling' || busyId === run.id"
                :aria-label="`Cancel Run ${run.id.slice(0, 8)}`"
                @click="act('cancel', run.id)"
                >Cancel</UiButton
              >
              <UiButton
                v-else
                size="sm"
                variant="outline-secondary"
                :disabled="busyId === run.id"
                :aria-label="`Rerun ${run.id.slice(0, 8)}`"
                @click="act('rerun', run.id)"
                >Rerun</UiButton
              >
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="page > 0 || hasMore" class="rv__pager">
      <UiButton variant="outline-secondary" size="sm" :disabled="page === 0" @click="page--"
        >Previous</UiButton
      >
      <span class="td-muted td-small">Page {{ page + 1 }}</span>
      <UiButton variant="outline-secondary" size="sm" :disabled="!hasMore" @click="page++"
        >Next</UiButton
      >
    </div>
  </UiCard>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import UiButton from '~/components/ui/UiButton.vue'
import UiCard from '~/components/ui/UiCard.vue'
import PageHeader from '~/components/PageHeader.vue'
import EmptyState from '~/components/platform/EmptyState.vue'
import LoadingState from '~/components/platform/LoadingState.vue'
import ProblemAlert from '~/components/platform/ProblemAlert.vue'
import StatusBadge from '~/components/platform/StatusBadge.vue'
import { formatDuration, formatTime, runDurationMs } from '~/components/platform/format'
import Icon from '~/components/ui/Icon.vue'
import { useAssetList, useEnvironments, useRunAction, useRunList } from '~/api/queries'
import { RUN_STATUS_VALUES, isActiveRunStatus, type RunSummary } from '~/api/types'

const PAGE_SIZE = 25
const router = useRouter()

const status = ref('')
const testId = ref('')
const environmentId = ref('')
const page = ref(0)
watch([status, testId, environmentId], () => (page.value = 0))

const params = computed(() => ({
  status: status.value || undefined,
  testId: testId.value || undefined,
  environmentId: environmentId.value || undefined,
  limit: PAGE_SIZE + 1,
  offset: page.value * PAGE_SIZE,
}))
const filtered = computed(() => Boolean(status.value || testId.value || environmentId.value))

const { data, error, isPending, isError, refetch } = useRunList(params)
const all = computed(() => data.value ?? [])
const runs = computed(() => all.value.slice(0, PAGE_SIZE))
const hasMore = computed(() => all.value.length > PAGE_SIZE)

const { data: tests } = useAssetList('tests')
const { data: environments } = useEnvironments()
const testName = (run: RunSummary) =>
  (tests.value ?? []).find((test) => test.id === run.test?.id)?.name ?? run.test?.id ?? 'Run'

const cancel = useRunAction('cancel')
const rerun = useRunAction('rerun')
const busyId = ref<string>()
const actionError = ref<unknown>()

const act = async (action: 'cancel' | 'rerun', id: string) => {
  busyId.value = id
  actionError.value = undefined
  try {
    const result = await (action === 'cancel' ? cancel : rerun).mutateAsync(id)
    if (action === 'rerun') await router.push(`/runs/${result.id}`)
  } catch (err) {
    actionError.value = err
  } finally {
    busyId.value = undefined
  }
}
</script>

<style scoped>
.rv__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--td-space-3);
  width: 100%;
}
.rv__filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--td-space-3);
}
.rv__filters .td-field {
  min-width: 10rem;
}
.rv__notices:not(:empty) {
  padding: var(--td-space-4) var(--td-space-4) 0;
}
.rv__table {
  overflow-x: auto;
}
.rv__name {
  font-weight: 650;
}
.rv__pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--td-space-3) var(--td-space-4);
  border-top: 1px solid var(--td-border);
}
</style>
