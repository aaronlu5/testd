<template>
  <div class="srd" data-testid="step-run-detail">
    <div class="td-row">
      <StatusBadge :status="stepRun.status" />
      <span class="td-muted td-small">Attempt {{ stepRun.attempt }}</span>
      <span class="td-muted td-small">Duration {{ formatDuration(stepRun.durationMs) }}</span>
    </div>
    <dl class="srd__dl td-small">
      <dt>Started</dt>
      <dd>{{ formatTime(stepRun.startedAt) }}</dd>
      <dt>Finished</dt>
      <dd>{{ formatTime(stepRun.finishedAt) }}</dd>
    </dl>

    <section v-if="stepRun.error" aria-labelledby="sr-error">
      <h3 id="sr-error">Error</h3>
      <UiAlert variant="danger" data-testid="step-error">
        <div class="srd__code">
          <UiBadge variant="danger">{{ describeFailureOrigin(stepRun.error.code) }}</UiBadge>
          <code>{{ stepRun.error.code }}</code>
        </div>
        <div>{{ stepRun.error.message }}</div>
        <div v-if="stepRun.error.detail" class="td-small srd__break">
          {{ stepRun.error.detail }}
        </div>
        <ul v-if="correlation.length > 0" class="td-small srd__list">
          <li v-for="[key, value] in correlation" :key="key">{{ key }}: {{ value }}</li>
        </ul>
      </UiAlert>
    </section>

    <section aria-labelledby="sr-input">
      <h3 id="sr-input">Resolved input <span class="srd__aside">(masked)</span></h3>
      <JsonView
        v-if="stepRun.resolvedInput !== undefined"
        :value="stepRun.resolvedInput"
        label="Resolved input"
        testid="step-input"
      />
      <p v-else class="td-muted td-small">No input was recorded.</p>
    </section>

    <section aria-labelledby="sr-output">
      <h3 id="sr-output">Output</h3>
      <template v-if="stepRun.outputPreview !== undefined">
        <UiAlert v-if="truncation" variant="warning" data-testid="output-truncated">
          Output is larger than the capture limit<span v-if="truncation.sizeBytes">
            ({{ truncation.sizeBytes }} bytes)</span
          >.
          <template v-if="fullOutput">
            <a
              :href="artifactApi.contentUrl(fullOutput.id)"
              target="_blank"
              rel="noopener noreferrer"
              >Open the full output</a
            >.
          </template>
        </UiAlert>
        <JsonView
          :value="truncation ? truncation.preview : stepRun.outputPreview"
          label="Output preview"
          testid="step-output"
        />
      </template>
      <p v-else class="td-muted td-small">This attempt produced no output.</p>
    </section>

    <section aria-labelledby="sr-logs">
      <h3 id="sr-logs">Logs</h3>
      <p v-if="stepRun.logs.length === 0" class="td-muted td-small">No log entries.</p>
      <ul v-else class="srd__logs td-small" data-testid="step-logs">
        <li v-for="(entry, index) in stepRun.logs" :key="index">
          <span class="td-muted">{{ new Date(entry.timestamp).toLocaleTimeString() }}</span>
          <UiBadge :variant="levelVariant(entry.level)">{{ entry.level }}</UiBadge>
          <span class="srd__break">{{ entry.message }}</span>
          <JsonView
            v-if="entry.data !== undefined"
            class="srd__log-data"
            :value="entry.data"
            label="Log data"
          />
        </li>
      </ul>
    </section>

    <section aria-labelledby="sr-artifacts">
      <h3 id="sr-artifacts">Artifacts</h3>
      <p v-if="stepRun.artifacts.length === 0" class="td-muted td-small">No artifacts.</p>
      <ul v-else class="srd__list td-small" data-testid="step-artifacts">
        <li v-for="artifact in stepRun.artifacts" :key="artifact.id">
          <a :href="artifactApi.contentUrl(artifact.id)" target="_blank" rel="noopener noreferrer">
            {{ artifact.label ?? artifact.id }}
          </a>
          <span class="td-muted">
            · {{ artifact.contentType }} · {{ artifact.sizeBytes }} bytes</span
          >
        </li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import UiAlert from '~/components/ui/UiAlert.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import { artifactApi } from '~/api/platform'
import type { StepRun } from '~/api/types'
import JsonView from '~/components/platform/JsonView.vue'
import StatusBadge from '~/components/platform/StatusBadge.vue'
import {
  describeFailureOrigin,
  formatDuration,
  formatTime,
  truncationOf,
} from '~/components/platform/format'

const props = defineProps<{ stepRun: StepRun }>()

const truncation = computed(() => truncationOf(props.stepRun.outputPreview))
const fullOutput = computed(() => props.stepRun.artifacts.find((a) => a.label === 'step-output'))
const correlation = computed(() => Object.entries(props.stepRun.error?.correlationIds ?? {}))

type BadgeVariant = 'danger' | 'warning' | 'info' | 'neutral'
const LEVELS: Record<string, BadgeVariant> = {
  error: 'danger',
  warn: 'warning',
  info: 'info',
  debug: 'neutral',
}
const levelVariant = (level: string): BadgeVariant => LEVELS[level] ?? 'neutral'
</script>

<style scoped>
.srd {
  display: flex;
  flex-direction: column;
  gap: var(--td-space-4);
}
.srd h3 {
  margin: 0 0 var(--td-space-2);
  font-size: var(--td-text-sm);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--td-accent-text);
}
.srd p {
  margin: 0;
}
.srd__aside {
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  color: var(--td-text-muted);
}
.srd__dl {
  display: grid;
  grid-template-columns: 6rem 1fr;
  gap: var(--td-space-1) var(--td-space-3);
  margin: 0;
}
.srd__dl dd {
  margin: 0;
}
.srd__code {
  display: flex;
  align-items: center;
  gap: var(--td-space-2);
  margin-bottom: var(--td-space-1);
}
.srd__break {
  overflow-wrap: anywhere;
}
.srd__list {
  margin: var(--td-space-2) 0 0;
  padding-left: var(--td-space-5);
}
.srd__logs {
  margin: 0;
  padding: 0;
  list-style: none;
}
.srd__logs li {
  margin-bottom: var(--td-space-2);
}
.srd__logs li > * + * {
  margin-left: var(--td-space-1);
}
.srd__log-data {
  display: block;
  margin: var(--td-space-1) 0 0;
}
</style>
