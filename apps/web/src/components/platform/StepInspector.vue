<template>
  <section class="si" aria-labelledby="inspector-title" data-testid="step-inspector">
    <div class="si__head">
      <div>
        <h2 id="inspector-title">Step settings</h2>
        <div class="td-muted td-small">{{ stepType?.displayName ?? node.type }}</div>
      </div>
      <UiButton size="sm" variant="outline-danger" @click="emit('remove')">Delete Step</UiButton>
    </div>

    <div class="td-field">
      <label for="step-name" class="td-label">Name</label>
      <input
        id="step-name"
        class="td-control"
        type="text"
        maxlength="200"
        :value="node.name"
        :aria-invalid="node.name.trim() === ''"
        @input="emit('update', { name: ($event.target as HTMLInputElement).value })"
      />
      <div v-if="node.name.trim() === ''" class="td-error" role="alert">A Step needs a name.</div>
      <div class="td-hint">
        Id: <code>{{ node.id }}</code> (used in <code v-pre>{{ steps.id.output }}</code
        >)
      </div>
    </div>

    <UiAlert v-if="!stepType" variant="warning">
      The Step type "{{ node.type }}" is not available on this server.
    </UiAlert>

    <template v-else>
      <p v-if="stepType.description" class="td-muted td-small si__p">{{ stepType.description }}</p>

      <p v-if="isBreakpoint" class="td-small si__p" data-testid="breakpoint-help">
        The Run pauses here, after the Steps above finish and before the next Step starts. While it
        is paused you can inspect what has happened and the input the next Step would receive, then
        resume or cancel. The message is plain text. A Breakpoint has no other settings: it takes no
        target, secret or command.
      </p>
      <ExpressionHelp v-else :previous="previous" />

      <SchemaForm
        :key="`${node.id}-${contentMode}`"
        :target-options="targetOptions"
        :hidden-keys="hiddenKeys"
        :code-languages="codeLanguages"
        :disabled-keys="isBlobUpload && contentMode === 'file' ? ['blobName'] : []"
        disabled-placeholder="Taken from each file's name"
        :fields="fields"
        :model-value="node.parameters"
        :errors="fieldErrors"
        :form-errors="validation.form"
        :id-prefix="`param-${node.id}`"
        @update:model-value="emit('update', { parameters: $event })"
      >
        <template v-if="isBlobUpload" #before-blobName>
          <BlobFileSource
            :mode="contentMode"
            :files="uploadFiles"
            :id-prefix="`param-${node.id}`"
            :server-error="fieldErrors.files"
            @mode="setContentMode"
            @files="setFiles"
          />
        </template>
      </SchemaForm>

      <details class="td-small si__defaults">
        <summary>Defaults for this Step type</summary>
        <JsonView :value="stepType.defaults" label="Default parameters" testid="step-defaults" />
      </details>
    </template>

    <fieldset v-if="!isBreakpoint" class="si__exec">
      <legend>Execution</legend>
      <div class="td-form-grid" style="--td-col: 12rem">
        <div class="td-field">
          <label for="exec-timeout" class="td-label">Timeout (seconds)</label>
          <input
            id="exec-timeout"
            class="td-control"
            inputmode="numeric"
            :value="node.execution?.timeoutSeconds ?? ''"
            placeholder="Environment default"
            :aria-invalid="Boolean(executionErrors.timeout)"
            @input="setTimeoutSeconds(($event.target as HTMLInputElement).value)"
          />
          <div v-if="executionErrors.timeout" class="td-error" role="alert">
            {{ executionErrors.timeout }}
          </div>
        </div>
        <div class="td-field">
          <label for="exec-attempts" class="td-label">Max attempts</label>
          <input
            id="exec-attempts"
            class="td-control"
            inputmode="numeric"
            :value="node.execution?.retry?.maxAttempts ?? ''"
            placeholder="1 (no retry)"
            :disabled="stepType?.capabilities.supportsRetry === false"
            :aria-invalid="Boolean(executionErrors.attempts)"
            @input="setAttempts(($event.target as HTMLInputElement).value)"
          />
          <div v-if="executionErrors.attempts" class="td-error" role="alert">
            {{ executionErrors.attempts }}
          </div>
          <div v-else-if="stepType?.capabilities.supportsRetry === false" class="td-hint">
            This Step type does not support retries.
          </div>
        </div>
      </div>
    </fieldset>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import UiAlert from '~/components/ui/UiAlert.vue'
import UiButton from '~/components/ui/UiButton.vue'
import type { EnvironmentSummary, JsonValue, StepTypeMetadata, TestNode } from '~/api/types'
import BlobFileSource, { type UploadFile } from '~/components/platform/BlobFileSource.vue'
import ExpressionHelp from '~/components/platform/ExpressionHelp.vue'
import JsonView from '~/components/platform/JsonView.vue'
import SchemaForm from '~/components/platform/SchemaForm.vue'
import { buildFields, validateParameters } from '~/components/platform/schema-form'

const props = withDefaults(
  defineProps<{
    node: TestNode
    stepType?: StepTypeMetadata
    /** Ids of Steps that run earlier; only these can be referenced. */
    previous?: string[]
    /** Messages from the API for this Step's parameters, keyed by parameter name. */
    serverErrors?: Record<string, string>
    /** Targets of the Environment chosen on the page, when one is chosen. */
    environmentTargets?: EnvironmentSummary['targets']
  }>(),
  { previous: () => [], serverErrors: () => ({}), environmentTargets: undefined },
)

const emit = defineEmits<{
  update: [patch: Partial<Omit<TestNode, 'id' | 'type'>>]
  remove: []
}>()

const isBreakpoint = computed(() => props.node.type === 'breakpoint')

const fields = computed(() =>
  buildFields(props.stepType?.configSchema, props.stepType?.sensitivePaths),
)
const validation = computed(() =>
  validateParameters(props.stepType?.configSchema, props.node.parameters),
)
const fieldErrors = computed(() => ({ ...props.serverErrors, ...validation.value.fields }))

const STEP_TARGET_KIND: Record<string, EnvironmentSummary['targets'][number]['kind']> = {
  'blob.upload': 'azureBlob',
  'blob.download': 'azureBlob',
  'serviceBus.send': 'azureServiceBus',
  'sql.query': 'sqlServer',
  'sql.execute': 'sqlServer',
  'http.request': 'http',
  waitForCondition: 'http',
}
const targetOptions = computed(() => {
  const kind = STEP_TARGET_KIND[props.node.type]
  return kind && props.environmentTargets
    ? props.environmentTargets.filter((target) => target.kind === kind)
    : undefined
})

const isBlobUpload = computed(() => props.node.type === 'blob.upload')
// Uploaded files live in the `files` parameter; without it the Step sends typed text or JSON.
const contentMode = ref<'text' | 'file'>(
  Array.isArray(props.node.parameters.files) ? 'file' : 'text',
)
const uploadFiles = computed(() =>
  Array.isArray(props.node.parameters.files)
    ? (props.node.parameters.files as unknown as UploadFile[])
    : [],
)
const hiddenKeys = computed(() => {
  // The mock response only matters while Mock is ticked.
  if (props.node.type === 'http.request')
    return props.node.parameters.mock === true ? [] : ['mockStatus', 'mockBody']
  if (!isBlobUpload.value) return []
  return contentMode.value === 'file' ? ['files', 'content', 'contentEncoding'] : ['files']
})
const codeLanguages = computed((): Record<string, 'sql'> => {
  const isSql = props.node.type === 'sql.query' || props.node.type === 'sql.execute'
  return isSql ? { statement: 'sql' } : {}
})
const setContentMode = (mode: 'text' | 'file') => {
  if (mode === contentMode.value) return
  contentMode.value = mode
  const rest = { ...props.node.parameters }
  for (const key of ['files', 'content', 'contentEncoding', 'blobName']) delete rest[key]
  emit('update', { parameters: mode === 'file' ? { ...rest, files: [] } : rest })
}
const setFiles = (files: UploadFile[]) => {
  const rest = { ...props.node.parameters }
  for (const key of ['content', 'contentEncoding', 'blobName']) delete rest[key]
  emit('update', { parameters: { ...rest, files: files as unknown as JsonValue } })
}

const executionErrors = reactive<{ timeout?: string; attempts?: string }>({})

const writeExecution = (execution: NonNullable<TestNode['execution']>) => {
  const empty = Object.keys(execution).length === 0
  emit('update', { execution: empty ? undefined : execution })
}

const setTimeoutSeconds = (text: string) => {
  const next = { ...props.node.execution }
  if (text.trim() === '') {
    delete next.timeoutSeconds
    delete executionErrors.timeout
  } else {
    const value = Number(text)
    if (!Number.isInteger(value) || value < 1) {
      executionErrors.timeout = 'Enter a whole number of seconds, at least 1.'
      return
    }
    delete executionErrors.timeout
    next.timeoutSeconds = value
  }
  writeExecution(next)
}

const setAttempts = (text: string) => {
  const next = { ...props.node.execution }
  if (text.trim() === '') {
    delete next.retry
    delete executionErrors.attempts
  } else {
    const value = Number(text)
    if (!Number.isInteger(value) || value < 1 || value > 20) {
      executionErrors.attempts = 'Enter a whole number from 1 to 20.'
      return
    }
    delete executionErrors.attempts
    next.retry = { ...next.retry, maxAttempts: value }
  }
  writeExecution(next)
}
</script>

<style scoped>
.si {
  display: flex;
  flex-direction: column;
  gap: var(--td-space-4);
}
.si__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--td-space-3);
}
.si__head h2 {
  margin: 0;
  font-size: var(--td-text-lg);
}
.si__p {
  margin: 0;
}
.si__defaults summary {
  cursor: pointer;
  font-weight: 650;
}
.si__defaults :deep(.json-view) {
  margin-top: var(--td-space-2);
}
.si__exec {
  min-width: 0;
  margin: 0;
  padding: var(--td-space-3) var(--td-space-4) var(--td-space-4);
  border: 1px solid var(--td-border);
  border-radius: var(--td-radius-md);
}
.si__exec legend {
  padding: 0 var(--td-space-2);
  font-size: var(--td-text-sm);
  font-weight: 650;
}
</style>
