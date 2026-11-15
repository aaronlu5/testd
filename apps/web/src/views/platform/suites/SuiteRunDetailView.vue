<template>
  <PageHeader title="Suite Run" subtitle="Suite Runs" subtitle-url="/suite-runs" />

  <LoadingState v-if="isPending" label="Loading Suite Run…" />
  <ProblemAlert
    v-else-if="isError && !suiteRun"
    :error="error"
    retryable
    @retry="() => refetch()"
  />

  <div v-else-if="suiteRun" class="srd">
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

    <UiCard>
      <div class="srd__head">
        <div>
          <h2>{{ suiteRun.suiteName }}</h2>
          <div class="td-row td-muted td-small">
            <StatusBadge :status="suiteRun.status" data-testid="suite-run-status" />
            <span
              >Suite Run <code>{{ suiteRun.id }}</code></span
            >
            <span v-if="suiteRun.rerunOfSuiteRunId">
              · rerun of
              <RouterLink :to="`/suite-runs/${suiteRun.rerunOfSuiteRunId}`">{{
                suiteRun.rerunOfSuiteRunId.slice(0, 8)
              }}</RouterLink>
            </span>
          </div>
        </div>
        <div class="td-row">
          <UiButton
            v-if="active"
            variant="outline-danger"
            :disabled="cancel.isPending.value || suiteRun.status === 'Cancelling'"
            data-testid="cancel-suite-run"
            @click="cancel.mutate(suiteRunId)"
          >
            {{ suiteRun.status === 'Cancelling' ? 'Cancelling…' : 'Cancel Suite Run' }}
          </UiButton>
          <UiButton
            v-else
            variant="outline-primary"
            :disabled="rerun.isPending.value"
            data-testid="rerun-suite-run"
            @click="onRerun"
            >Rerun Suite</UiButton
          >
        </div>
      </div>

      <ProblemAlert :error="cancel.error.value ?? rerun.error.value" />

      <dl class="srd__dl td-small">
        <dt>Environment</dt>
        <dd>{{ suiteRun.environmentId }}</dd>
        <dt>Concurrency</dt>
        <dd data-testid="suite-concurrency">{{ suiteRun.maxConcurrency }} at a time</dd>
        <dt>Requested by</dt>
        <dd>{{ suiteRun.requestedBy }}</dd>
        <dt>Started</dt>
        <dd>{{ formatTime(suiteRun.startedAt) }}</dd>
      </dl>
    </UiCard>

    <UiCard title="Child Runs">
      <SuiteRunSummary :suite-run="suiteRun" :items="suiteRun.items" />
    </UiCard>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import UiAlert from '~/components/ui/UiAlert.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiCard from '~/components/ui/UiCard.vue'
import PageHeader from '~/components/PageHeader.vue'
import LoadingState from '~/components/platform/LoadingState.vue'
import ProblemAlert from '~/components/platform/ProblemAlert.vue'
import StatusBadge from '~/components/platform/StatusBadge.vue'
import SuiteRunSummary from '~/components/platform/SuiteRunSummary.vue'
import { formatTime } from '~/components/platform/format'
import { useSuiteRun, useSuiteRunAction } from '~/api/queries'
import { useSuiteRunStream } from '~/api/run-stream'
import { isActiveSuiteRunStatus } from '~/api/types'

const route = useRoute()
const router = useRouter()
const suiteRunId = computed(() => route.params.id as string)

const pollMs = ref<number | false>(5000)
const { data: suiteRun, error, isError, isPending, refetch } = useSuiteRun(suiteRunId, pollMs)
const active = computed(() =>
  suiteRun.value ? isActiveSuiteRunStatus(suiteRun.value.status) : false,
)
const stream = useSuiteRunStream(suiteRunId, active)
watch(
  stream.state,
  (state) => {
    pollMs.value = state === 'polling' ? 2000 : 5000
  },
  { immediate: true },
)

const cancel = useSuiteRunAction('cancel')
const rerun = useSuiteRunAction('rerun')
const onRerun = async () => {
  const created = await rerun.mutateAsync(suiteRunId.value)
  await router.push(`/suite-runs/${created.id}`)
}
</script>

<style scoped>
.srd {
  display: flex;
  flex-direction: column;
  gap: var(--td-space-4);
}
.srd__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--td-space-3);
}
.srd__head h2 {
  margin: 0 0 var(--td-space-1);
}
.srd__dl {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(7rem, max-content) minmax(8rem, 1fr));
  gap: var(--td-space-1) var(--td-space-4);
  margin: var(--td-space-4) 0 0;
}
.srd__dl dt {
  color: var(--td-text-muted);
}
.srd__dl dd {
  margin: 0;
}
</style>
