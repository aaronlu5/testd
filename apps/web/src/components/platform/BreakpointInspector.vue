<template>
  <UiCard title="Inspect before continuing" data-testid="breakpoint-inspector">
    <div class="bpi">
      <p class="td-small td-muted" data-testid="inspection-notice">
        This view is read-only. Resuming continues the same Run from its saved snapshot; nothing
        shown here can be edited, and nothing is re-run.
      </p>

      <section aria-labelledby="bp-message">
        <h3 id="bp-message">Message from the author</h3>
        <p v-if="pause.message" class="bpi__break" data-testid="pause-message">
          {{ pause.message }}
        </p>
        <p v-else class="td-muted td-small">The author left no message.</p>
      </section>

      <section aria-labelledby="bp-completed">
        <h3 id="bp-completed">Completed Steps</h3>
        <p v-if="completedSteps.length === 0" class="td-muted td-small">
          No Step finished before this Breakpoint.
        </p>
        <ul v-else class="bpi__steps" data-testid="completed-steps">
          <li v-for="step in completedSteps" :key="step.id">
            <StatusBadge :status="step.status" />
            <span class="bpi__step-name td-truncate">{{ names[step.nodeId] ?? step.nodeId }}</span>
            <span class="td-muted td-small">{{ formatDuration(step.durationMs) }}</span>
            <UiButton
              size="sm"
              variant="outline-primary"
              :aria-label="`Output and logs for ${names[step.nodeId] ?? step.nodeId}`"
              @click="emit('open-step', step.id)"
              >Details</UiButton
            >
          </li>
        </ul>
      </section>

      <section aria-labelledby="bp-next">
        <h3 id="bp-next">
          Input the next Step will receive
          <span class="td-muted bpi__aside">(masked)</span>
        </h3>
        <template v-if="pause.nextNodeId">
          <p class="td-small">
            <strong>{{ pause.nextNodeName ?? pause.nextNodeId }}</strong>
            <span v-if="pause.nextNodeType" class="td-muted"> · {{ pause.nextNodeType }}</span>
          </p>
          <JsonView
            v-if="pause.nextResolvedInputPreview !== undefined"
            :value="pause.nextResolvedInputPreview"
            label="Masked input for the next Step"
            testid="next-input"
          />
          <p v-else class="td-muted td-small">No input preview was recorded.</p>
          <a
            v-if="pause.nextInputArtifactId"
            class="td-small"
            :href="artifactUrl(pause.nextInputArtifactId)"
            target="_blank"
            rel="noopener"
            data-testid="next-input-artifact"
            >Open the full masked input</a
          >
        </template>
        <p v-else class="td-muted td-small" data-testid="end-of-flow">
          No Step follows this Breakpoint. Resuming finishes the Run.
        </p>
      </section>

      <ProblemAlert :error="error" />

      <div class="td-row" role="group" aria-label="Paused Run actions">
        <UiButton
          variant="success"
          :disabled="!actionable"
          :aria-label="resumeLabel"
          data-testid="resume-run"
          @click="emit('resume', pause.continuationGeneration)"
        >
          {{ resuming ? 'Resuming…' : 'Resume' }}
        </UiButton>
        <UiButton
          variant="outline-danger"
          :disabled="!actionable"
          :aria-label="cancelLabel"
          data-testid="cancel-paused-run"
          @click="emit('cancel')"
        >
          {{ cancelling ? 'Cancelling…' : 'Cancel Run' }}
        </UiButton>
        <span v-if="!isPaused" class="td-small td-muted" data-testid="not-paused">
          The Run is no longer paused ({{ runStatus }}); actions are unavailable.
        </span>
      </div>
    </div>
  </UiCard>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiCard from '~/components/ui/UiCard.vue'
import JsonView from '~/components/platform/JsonView.vue'
import ProblemAlert from '~/components/platform/ProblemAlert.vue'
import StatusBadge from '~/components/platform/StatusBadge.vue'
import { formatDuration } from '~/components/platform/format'
import { artifactApi } from '~/api/platform'
import type { PausedStepSummary, RunPause } from '~/api/types'

const props = defineProps<{
  pause: RunPause
  completedSteps: PausedStepSummary[]
  /** Step names by node id, from the Run snapshot. */
  names: Record<string, string>
  /** The Run's current status; actions are offered only while it is Paused. */
  runStatus: string
  breakpointName: string
  resuming?: boolean
  cancelling?: boolean
  error?: unknown
}>()

const emit = defineEmits<{
  resume: [continuationGeneration: number]
  cancel: []
  'open-step': [stepRunId: string]
}>()

const isPaused = computed(() => props.runStatus === 'Paused')
const actionable = computed(() => isPaused.value && !props.resuming && !props.cancelling)
const nextText = computed(() =>
  props.pause.nextNodeId
    ? `next Step: ${props.pause.nextNodeName ?? props.pause.nextNodeId}`
    : 'no Step follows',
)
const resumeLabel = computed(
  () => `Resume the Run after breakpoint “${props.breakpointName}”; ${nextText.value}`,
)
const cancelLabel = computed(
  () =>
    `Cancel the Run paused at breakpoint “${props.breakpointName}”; ${nextText.value} will not run`,
)
const artifactUrl = (id: string) => artifactApi.contentUrl(id)
</script>

<style scoped>
.bpi {
  display: flex;
  flex-direction: column;
  gap: var(--td-space-4);
}
.bpi p {
  margin: 0;
}
.bpi h3 {
  margin: 0 0 var(--td-space-2);
  font-size: var(--td-text-sm);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--td-accent-text);
}
.bpi__aside {
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
}
.bpi__break {
  overflow-wrap: anywhere;
}
.bpi__steps {
  display: flex;
  flex-direction: column;
  gap: var(--td-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.bpi__steps li {
  display: flex;
  align-items: center;
  gap: var(--td-space-2);
}
.bpi__step-name {
  flex: 1 1 auto;
}
</style>
