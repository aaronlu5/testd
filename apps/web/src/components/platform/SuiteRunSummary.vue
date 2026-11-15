<template>
  <div class="srs" data-testid="suite-run-summary">
    <UiAlert v-if="waiting" variant="warning" role="status" data-testid="waiting-for-breakpoint">
      <div class="srs__title">Waiting for a breakpoint</div>
      {{ pausedCount === 1 ? 'A child Run is' : `${pausedCount} child Runs are` }} paused at a
      Breakpoint. Paused Runs keep their concurrency slot, so the Suite cannot start more Tests than
      its limit allows until they are resumed or cancelled. Open a paused child below.
    </UiAlert>

    <ul class="srs__counts" aria-label="Child Run totals" data-testid="suite-counts">
      <li>
        <strong data-testid="count-total">{{ suiteRun.counts.total }}</strong> total
      </li>
      <li v-for="entry in shownCounts" :key="entry.status">
        <StatusBadge :status="entry.status" />
        <span :data-testid="`count-${entry.status}`">{{ entry.count }}</span>
      </li>
    </ul>

    <div v-if="items" class="td-table-wrap">
      <table class="td-table" data-testid="suite-items">
        <caption class="td-sr-only">
          Child Runs in Suite order
        </caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Test</th>
            <th scope="col">Test Data</th>
            <th scope="col">Status</th>
            <th scope="col"><span class="td-sr-only">Child Run</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in items" :key="item.id" :data-testid="`suite-item-${item.position}`">
            <td>{{ item.position + 1 }}</td>
            <td>{{ item.testName }}</td>
            <td>{{ item.dataSetName }}</td>
            <td><StatusBadge :status="item.status" /></td>
            <td class="td-cell-actions">
              <UiButton
                v-if="item.runId"
                :to="`/runs/${item.runId}`"
                size="sm"
                :variant="item.status === 'Paused' ? 'warning' : 'outline-primary'"
                :aria-label="`${item.status === 'Paused' ? 'Open paused child Run' : 'Open child Run'} for ${item.testName}`"
                >{{ item.status === 'Paused' ? 'Resume or cancel…' : 'Open' }}</UiButton
              >
              <span v-else class="td-muted td-small">Not started</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import UiAlert from '~/components/ui/UiAlert.vue'
import UiButton from '~/components/ui/UiButton.vue'
import StatusBadge from '~/components/platform/StatusBadge.vue'
import type { SuiteRunItemView, SuiteRunCounts, SuiteRunStatus } from '~/api/types'

const props = defineProps<{
  suiteRun: { status: SuiteRunStatus; counts: SuiteRunCounts }
  /** Omit for the compact (list) form. */
  items?: SuiteRunItemView[]
}>()

const ORDER = [
  'Pending',
  'Queued',
  'Running',
  'Paused',
  'Cancelling',
  'Succeeded',
  'Failed',
  'Cancelled',
  'Skipped',
] as const

const shownCounts = computed(() =>
  ORDER.map((status) => ({ status, count: props.suiteRun.counts[status] })).filter(
    (entry) => entry.count > 0,
  ),
)
const pausedCount = computed(() => props.suiteRun.counts.Paused)
const waiting = computed(() => props.suiteRun.status === 'WaitingForBreakpoint')
</script>

<style scoped>
.srs__title {
  font-weight: 650;
}
.srs__counts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--td-space-4);
  margin: 0 0 var(--td-space-4);
  padding: 0;
  list-style: none;
}
.srs__counts li {
  display: inline-flex;
  align-items: center;
  gap: var(--td-space-1);
}
.srs :deep(.ui-alert) {
  margin-bottom: var(--td-space-4);
}
</style>
