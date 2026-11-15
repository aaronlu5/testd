<template>
  <PageHeader title="Suite Runs" subtitle="Test Platform" />

  <UiCard flush data-testid="suite-run-history">
    <template #header>
      <div class="srv__bar">
        <div class="td-field srv__filter">
          <label for="sr-status" class="td-hint">Status</label>
          <select id="sr-status" v-model="status" class="td-control">
            <option value="">All</option>
            <option v-for="value in SUITE_RUN_STATUS_VALUES" :key="value" :value="value">
              {{ value.replace(/([a-z])([A-Z])/g, '$1 $2') }}
            </option>
          </select>
        </div>
        <UiButton to="/suite-runs/new" variant="primary" data-testid="new-suite-run">
          <Icon name="player-play" :size="16" /> Run a Suite
        </UiButton>
      </div>
    </template>

    <div class="srv__notices">
      <ProblemAlert :error="error" retryable @retry="() => refetch()" />
    </div>
    <LoadingState v-if="isPending" label="Loading Suite Runs…" />
    <EmptyState
      v-else-if="!isError && runs.length === 0"
      :title="status ? 'No Suite Runs match this filter' : 'No Suite Runs yet'"
      :description="
        status ? 'Clear the filter to see more.' : 'Run a Suite to see its results here.'
      "
    />
    <div
      v-else-if="runs.length > 0"
      class="srv__table"
      tabindex="0"
      role="region"
      aria-label="Suite Runs (scrollable)"
    >
      <table class="td-table">
        <caption class="td-sr-only">
          Suite Runs
        </caption>
        <thead>
          <tr>
            <th scope="col">Suite</th>
            <th scope="col">Status</th>
            <th scope="col">Progress</th>
            <th scope="col">Requested</th>
            <th scope="col"><span class="td-sr-only">Open</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="run in runs" :key="run.id" data-testid="suite-run-row">
            <td>{{ run.suiteName }}</td>
            <td><StatusBadge :status="run.status" /></td>
            <td class="td-small">
              {{
                run.counts.Succeeded + run.counts.Failed + run.counts.Cancelled + run.counts.Skipped
              }}
              of {{ run.counts.total }} finished
              <span v-if="run.counts.Paused > 0" class="srv__paused">
                · {{ run.counts.Paused }} paused
              </span>
            </td>
            <td>{{ formatTime(run.requestedAt) }}</td>
            <td class="td-cell-actions">
              <UiButton
                :to="`/suite-runs/${run.id}`"
                size="sm"
                variant="outline-primary"
                :aria-label="`Open Suite Run for ${run.suiteName}`"
                >Open</UiButton
              >
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </UiCard>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiCard from '~/components/ui/UiCard.vue'
import PageHeader from '~/components/PageHeader.vue'
import EmptyState from '~/components/platform/EmptyState.vue'
import LoadingState from '~/components/platform/LoadingState.vue'
import ProblemAlert from '~/components/platform/ProblemAlert.vue'
import StatusBadge from '~/components/platform/StatusBadge.vue'
import { formatTime } from '~/components/platform/format'
import Icon from '~/components/ui/Icon.vue'
import { useSuiteRunList } from '~/api/queries'
import { SUITE_RUN_STATUS_VALUES, type SuiteRunStatus } from '~/api/types'

const status = ref<SuiteRunStatus | ''>('')
const params = computed(() => (status.value ? { status: status.value } : {}))
const { data, error, isError, isPending, refetch } = useSuiteRunList(params)
const runs = computed(() => data.value ?? [])
</script>

<style scoped>
.srv__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--td-space-3);
  width: 100%;
}
.srv__filter {
  min-width: 11rem;
}
.srv__notices:not(:empty) {
  padding: var(--td-space-4) var(--td-space-4) 0;
}
.srv__table {
  overflow-x: auto;
}
.srv__paused {
  color: var(--td-paused);
}
</style>
