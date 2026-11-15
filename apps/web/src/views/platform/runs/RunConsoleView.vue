<template>
  <PageHeader title="Run" subtitle="Runs" subtitle-url="/runs" />

  <LoadingState v-if="isPending" label="Loading Run…" />
  <ProblemAlert v-else-if="isError && !run" :error="error" retryable @retry="() => refetch()" />

  <div v-else-if="run" class="rc">
    <ProblemAlert v-if="isError" :error="error" retryable @retry="() => refetch()" />
    <UiAlert
      v-if="stream.state.value === 'reconnecting' && active"
      variant="warning"
      data-testid="stream-reconnecting"
    >
      Live updates were interrupted. Reconnecting…
    </UiAlert>
    <UiAlert
      v-else-if="stream.state.value === 'polling' && active"
      variant="info"
      data-testid="stream-polling"
    >
      Live updates are unavailable; this page refreshes every few seconds instead.
    </UiAlert>

    <template v-if="isPaused">
      <PausedRunBanner
        v-if="pause"
        :breakpoint-name="breakpointName"
        :next-name="pause.pause.nextNodeName ?? pause.pause.nextNodeId ?? undefined"
        :paused-at="pause.pause.pausedAt"
      />
      <UiAlert v-else variant="warning" role="status" data-testid="paused-loading">
        <div class="rc__paused-title">Paused at a breakpoint</div>
        <span v-if="pauseLoading">Loading what the Run is waiting on…</span>
        <ProblemAlert v-else :error="pauseError" retryable @retry="() => refetchPause()" />
      </UiAlert>
    </template>

    <UiCard data-testid="run-summary">
      <div class="rc__head">
        <div>
          <h2>{{ run.snapshots.test?.name ?? 'Run' }}</h2>
          <div class="td-row td-muted td-small">
            <StatusBadge :status="run.status" data-testid="run-status" />
            <span
              >Run <code>{{ run.id }}</code></span
            >
            <span v-if="run.rerunOfRunId">
              · rerun of
              <RouterLink :to="`/runs/${run.rerunOfRunId}`">{{
                run.rerunOfRunId.slice(0, 8)
              }}</RouterLink>
            </span>
          </div>
        </div>
        <div class="td-row">
          <UiButton
            v-if="active && !isPaused"
            variant="outline-danger"
            :disabled="cancel.isPending.value || run.status === 'Cancelling'"
            data-testid="cancel-run"
            @click="onCancel"
          >
            {{ run.status === 'Cancelling' ? 'Cancelling…' : 'Cancel Run' }}
          </UiButton>
          <UiButton
            v-else-if="!active"
            variant="outline-primary"
            :disabled="rerun.isPending.value"
            data-testid="rerun-run"
            @click="onRerun"
            >Rerun</UiButton
          >
        </div>
      </div>

      <ProblemAlert :error="cancel.error.value ?? rerun.error.value" />

      <dl class="rc__dl td-small">
        <dt>Environment</dt>
        <dd>
          {{ run.snapshots.environment.name }} ({{ run.snapshots.environment.classification }})
        </dd>
        <dt>Requested by</dt>
        <dd>{{ run.requestedBy }}</dd>
        <dt>Test</dt>
        <dd>v{{ run.test?.version }}</dd>
        <dt>Test Data</dt>
        <dd>{{ run.snapshots.testData?.name }} v{{ run.testData?.version }}</dd>
        <dt>Started</dt>
        <dd>{{ formatTime(run.startedAt) }}</dd>
        <dt>Duration</dt>
        <dd>{{ formatDuration(runDurationMs(run)) }}</dd>
        <template v-if="overrideEntries.length > 0">
          <dt>Overrides</dt>
          <dd class="rc__wide">
            <code v-for="[key, value] in overrideEntries" :key="key" class="rc__override"
              >{{ key }}={{ JSON.stringify(value) }}</code
            >
          </dd>
        </template>
      </dl>

      <UiAlert v-if="run.error" variant="danger" class="rc__error" data-testid="run-error">
        <div class="rc__code">
          <UiBadge variant="danger">{{ describeFailureOrigin(run.error.code) }}</UiBadge>
          <code>{{ run.error.code }}</code>
        </div>
        {{ run.error.message }}
        <div v-if="run.error.detail" class="td-small rc__break">{{ run.error.detail }}</div>
      </UiAlert>
    </UiCard>

    <BreakpointInspector
      v-if="isPaused && pause"
      :pause="pause.pause"
      :completed-steps="pause.completedSteps"
      :names="Object.fromEntries(nodeNames)"
      :run-status="run.status"
      :breakpoint-name="breakpointName"
      :resuming="resume.isPending.value"
      :cancelling="cancel.isPending.value"
      :error="resume.error.value ?? cancel.error.value"
      @resume="onResume"
      @cancel="onCancel"
      @open-step="openStep"
    />

    <div class="rc__grid">
      <UiCard title="Execution">
        <FlowCanvas
          v-if="run.snapshots.test"
          :nodes="run.snapshots.test.nodes"
          :edges="run.snapshots.test.edges"
          :statuses="nodeStatuses"
          :selected-id="selectedNodeId"
          readonly
          height="24rem"
          @select="onSelectNode"
        />
      </UiCard>

      <UiCard title="Timeline" flush>
        <EmptyState v-if="rows.length === 0" title="No Steps have started yet" />
        <div
          v-else
          class="rc__table"
          tabindex="0"
          role="region"
          aria-label="Step timeline (scrollable)"
        >
          <table class="td-table" data-testid="step-timeline">
            <caption class="td-sr-only">
              Step runs
            </caption>
            <thead>
              <tr>
                <th scope="col">Step</th>
                <th scope="col">Attempt</th>
                <th scope="col">Status</th>
                <th scope="col">Duration</th>
                <th scope="col"><span class="td-sr-only">Details</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.step.id" data-testid="step-row">
                <td>{{ row.name }}</td>
                <td>{{ row.step.attempt }}</td>
                <td><StatusBadge :status="row.step.status" /></td>
                <td>{{ formatDuration(row.step.durationMs) }}</td>
                <td class="td-cell-actions">
                  <UiButton
                    size="sm"
                    variant="outline-primary"
                    :aria-label="`Details for ${row.name}, attempt ${row.step.attempt}`"
                    @click="openStep(row.step.id)"
                    >Details</UiButton
                  >
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </UiCard>
    </div>

    <UiDrawer v-model="drawerOpen" :title="drawerTitle" size="md" data-testid="step-drawer">
      <StepRunDetail v-if="openedStep" :step-run="openedStep" />
    </UiDrawer>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import UiAlert from '~/components/ui/UiAlert.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiDrawer from '~/components/ui/UiDrawer.vue'
import PageHeader from '~/components/PageHeader.vue'
import EmptyState from '~/components/platform/EmptyState.vue'
import FlowCanvas from '~/components/platform/FlowCanvas.vue'
import LoadingState from '~/components/platform/LoadingState.vue'
import ProblemAlert from '~/components/platform/ProblemAlert.vue'
import StatusBadge from '~/components/platform/StatusBadge.vue'
import BreakpointInspector from '~/components/platform/BreakpointInspector.vue'
import PausedRunBanner from '~/components/platform/PausedRunBanner.vue'
import StepRunDetail from '~/components/platform/StepRunDetail.vue'
import {
  describeFailureOrigin,
  formatDuration,
  formatTime,
  runDurationMs,
} from '~/components/platform/format'
import { usePause, useResumeRun, useRun, useRunAction } from '~/api/queries'
import { useRunStream } from '~/api/run-stream'
import { isActiveRunStatus } from '~/api/types'

const route = useRoute()
const runId = computed(() => route.params.id as string)

const pollMs = ref<number | false>(5000)
const { data: run, error, isError, isPending, refetch } = useRun(runId, pollMs)

const active = computed(() => (run.value ? isActiveRunStatus(run.value.status) : false))
const stream = useRunStream(runId, active)
// The stream delivers changes immediately; polling is a safety net, and the main path when SSE fails.
watch(
  stream.state,
  (state) => {
    pollMs.value = state === 'polling' ? 2000 : 5000
  },
  { immediate: true },
)

const isPaused = computed(() => run.value?.status === 'Paused')
// Read only while the Run is paused. Re-keyed by generation so a new pause is never shown stale.
const {
  data: pause,
  error: pauseError,
  isPending: pauseLoading,
  refetch: refetchPause,
} = usePause(runId, isPaused, () => run.value?.continuationGeneration)

const resume = useResumeRun()
const onResume = (continuationGeneration: number) =>
  resume.mutate({ id: runId.value, continuationGeneration })

const cancel = useRunAction('cancel')
const rerun = useRunAction('rerun')
const onCancel = () => cancel.mutate(runId.value)
const onRerun = async () => {
  const created = await rerun.mutateAsync(runId.value)
  await router.push(`/runs/${created.id}`)
}

const router = useRouter()

const overrideEntries = computed(() => Object.entries(run.value?.variableOverrides ?? {}))

const breakpointName = computed(
  () =>
    nodeNames.value.get(pause.value?.pause.breakpointNodeId ?? '') ??
    pause.value?.pause.breakpointNodeId ??
    'Breakpoint',
)

const nodeNames = computed(
  () => new Map((run.value?.snapshots.test?.nodes ?? []).map((node) => [node.id, node.name])),
)

const rows = computed(() => {
  const order = (run.value?.snapshots.test?.nodes ?? []).map((node) => node.id)
  return [...(run.value?.stepRuns ?? [])]
    .sort(
      (a, b) =>
        (a.startedAt ?? '').localeCompare(b.startedAt ?? '') ||
        order.indexOf(a.nodeId) - order.indexOf(b.nodeId) ||
        a.attempt - b.attempt,
    )
    .map((step) => ({ step, name: nodeNames.value.get(step.nodeId) ?? step.nodeId }))
})

/** Status of the latest attempt of each Step, for the graph. */
const nodeStatuses = computed(() => {
  const latest = new Map<string, { attempt: number; status: string }>()
  for (const step of run.value?.stepRuns ?? []) {
    const known = latest.get(step.nodeId)
    if (!known || known.attempt < step.attempt)
      latest.set(step.nodeId, { attempt: step.attempt, status: step.status })
  }
  return Object.fromEntries([...latest].map(([id, value]) => [id, value.status]))
})

const drawerOpen = ref(false)
const openedId = ref<string>()
const selectedNodeId = ref<string>()
const openedStep = computed(() => run.value?.stepRuns.find((step) => step.id === openedId.value))
const drawerTitle = computed(() =>
  openedStep.value
    ? `${nodeNames.value.get(openedStep.value.nodeId) ?? openedStep.value.nodeId} · attempt ${openedStep.value.attempt}`
    : 'Step',
)

const openStep = (id: string) => {
  openedId.value = id
  selectedNodeId.value = openedStep.value?.nodeId
  drawerOpen.value = true
}
const onSelectNode = (nodeId: string | undefined) => {
  if (!nodeId) return
  const attempts = (run.value?.stepRuns ?? []).filter((step) => step.nodeId === nodeId)
  const latest = attempts.sort((a, b) => b.attempt - a.attempt)[0]
  if (latest) openStep(latest.id)
}
</script>

<style scoped>
.rc {
  display: flex;
  flex-direction: column;
  gap: var(--td-space-4);
}
.rc__paused-title {
  font-size: var(--td-text-lg);
  font-weight: 700;
}
.rc__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--td-space-3);
}
.rc__head h2 {
  margin: 0 0 var(--td-space-1);
}
.rc__dl {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr) max-content minmax(0, 1fr);
  gap: var(--td-space-1) var(--td-space-4);
  margin: var(--td-space-4) 0 0;
}
.rc__dl dt {
  color: var(--td-text-muted);
}
.rc__dl dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.rc__wide {
  grid-column: 2 / -1;
}
.rc__override {
  margin-right: var(--td-space-2);
}
@media (max-width: 47.99rem) {
  .rc__dl {
    grid-template-columns: max-content minmax(0, 1fr);
  }
}
.rc__error {
  margin-top: var(--td-space-3);
}
.rc__code {
  display: flex;
  align-items: center;
  gap: var(--td-space-2);
  margin-bottom: var(--td-space-1);
}
.rc__break {
  margin-top: var(--td-space-1);
  overflow-wrap: anywhere;
}
.rc__grid {
  display: grid;
  grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
  gap: var(--td-space-4);
  align-items: start;
}
@media (max-width: 79.99rem) {
  .rc__grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
.rc__table {
  overflow-x: auto;
}
</style>
