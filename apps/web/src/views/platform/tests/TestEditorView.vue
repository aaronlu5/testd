<template>
  <PageHeader
    :title="store.isNew ? 'New Test' : 'Edit Test'"
    subtitle="Tests"
    subtitle-url="/tests"
  />

  <LoadingState v-if="loadingExisting" label="Loading Test…" />
  <ProblemAlert v-else-if="loadError" :error="loadError" retryable @retry="() => refetch()" />

  <div v-else class="te">
    <UiCard>
      <div class="te__top">
        <div class="td-form-grid te__fields" style="--td-col: 12rem">
          <div class="td-field">
            <label for="test-name" class="td-label">Name</label>
            <input
              id="test-name"
              v-model="store.draft.name"
              class="td-control"
              type="text"
              maxlength="200"
              :aria-invalid="store.draft.name.trim() === ''"
            />
          </div>
          <div class="td-field">
            <label for="test-description" class="td-label">Description</label>
            <input
              id="test-description"
              v-model="store.draft.description"
              class="td-control"
              type="text"
              maxlength="2000"
            />
          </div>
          <div class="td-field">
            <label for="test-tags" class="td-label">Tags</label>
            <input
              id="test-tags"
              class="td-control"
              type="text"
              placeholder="comma separated"
              :value="tagsText"
              @input="onTags(($event.target as HTMLInputElement).value)"
            />
          </div>
        </div>

        <div class="te__actions">
          <div class="td-row">
            <UiButton
              variant="primary"
              :disabled="
                saving || store.clientIssues.length > 0 || Boolean(variablesError) || !store.dirty
              "
              data-testid="save-test"
              @click="save"
            >
              {{ saving ? 'Saving…' : 'Save' }}
            </UiButton>
            <UiButton
              variant="outline-primary"
              :disabled="validating || store.isNew || store.clientIssues.length > 0"
              :title="
                selectedEnvironment
                  ? `Validate against ${selectedEnvironment.name}`
                  : 'Validate without an Environment (choose one in the top bar to check targets)'
              "
              data-testid="validate-test"
              @click="validateOnServer"
              >Validate on server</UiButton
            >
            <UiButton
              v-if="!store.isNew"
              :to="{ path: '/runs/new', query: { testId: store.assetId } }"
              variant="outline-success"
              :disabled="store.dirty"
              >Run</UiButton
            >
            <UiBadge v-if="store.dirty" variant="warning" data-testid="unsaved-badge"
              >Unsaved changes</UiBadge
            >
            <UiBadge v-else-if="!store.isNew" variant="success"
              >Saved · v{{ store.version }}</UiBadge
            >
          </div>
          <span v-if="store.isNew" class="td-muted td-small"
            >Save once to enable server validation and running.</span
          >
        </div>
      </div>
    </UiCard>

    <ProblemAlert :error="saveError" />
    <UiAlert
      v-if="validationResult"
      :variant="validationResult.valid ? 'success' : 'warning'"
      data-testid="validation-result"
    >
      <template v-if="validationResult.valid">The server accepts this Test.</template>
      <template v-else>The server found {{ validationResult.issues.length }} problem(s):</template>
      <ul
        v-if="validationResult.normalization?.orderChanged"
        class="te__list"
        data-testid="normalization-moves"
      >
        <li v-for="move in validationResult.normalization.moves" :key="move">{{ move }}</li>
      </ul>
    </UiAlert>
    <UiAlert
      v-if="orderNotice"
      variant="info"
      dismissible
      data-testid="order-changed"
      @dismiss="orderNotice = ''"
    >
      {{ orderNotice }}
    </UiAlert>
    <UiAlert
      v-if="rejection"
      variant="info"
      dismissible
      data-testid="connection-rejected"
      @dismiss="rejection = ''"
    >
      {{ rejection }}
    </UiAlert>

    <UiAlert
      v-if="store.clientIssues.length > 0 || mapped.general.length > 0"
      variant="warning"
      role="status"
      data-testid="client-issues"
    >
      <div class="te__issues-title">To do before this Test can be saved</div>
      <ul class="te__list">
        <li v-for="(issue, index) in store.clientIssues" :key="`c${index}`">{{ issue.message }}</li>
        <li v-for="(issue, index) in mapped.general" :key="`s${index}`">
          {{ issue.message }}
        </li>
      </ul>
    </UiAlert>

    <div class="te__grid">
      <div class="te__col te__col--left">
        <UiCard title="Steps">
          <LoadingState v-if="typesPending" label="Loading Step types…" />
          <ProblemAlert :error="typesError" retryable @retry="() => refetchTypes()" />
          <ul class="te__palette" data-testid="palette">
            <li v-for="type in stepTypes ?? []" :key="type.type">
              <UiButton
                block
                class="te__palette-btn"
                variant="outline-secondary"
                :title="type.description"
                :aria-label="`Add ${type.displayName} Step`"
                @click="store.addStep(type)"
              >
                <Icon name="plus" :size="14" /> {{ type.displayName }}
              </UiButton>
            </li>
          </ul>
        </UiCard>

        <UiCard title="Order">
          <StepOrderList
            :items="orderedNodes"
            :selected-id="store.selectedId"
            :movable="store.positionDriven || store.analysis.valid"
            :announcement="store.announcement"
            @select="store.selectedId = $event"
            @move="store.moveStep"
            @remove="store.removeStep"
          />
        </UiCard>
      </div>

      <div class="te__col te__col--mid">
        <UiCard>
          <template #header>
            <div class="te__seq-head">
              <span class="te__seq-title"
                >Sequence
                <UiBadge
                  :variant="store.positionDriven ? 'primary' : 'neutral'"
                  data-testid="sequence-mode"
                  >{{ store.positionDriven ? 'Position-driven' : 'Manual connections' }}</UiBadge
                ></span
              >
              <div class="td-row te__seq-buttons">
                <UiButton
                  size="sm"
                  variant="outline-secondary"
                  :disabled="!store.canUndo"
                  aria-label="Undo the last layout change"
                  aria-keyshortcuts="Control+Z"
                  data-testid="undo"
                  @click="store.undo()"
                  >Undo</UiButton
                >
                <UiButton
                  size="sm"
                  variant="outline-secondary"
                  :disabled="!store.canRedo"
                  aria-label="Redo the layout change"
                  aria-keyshortcuts="Control+Y"
                  data-testid="redo"
                  @click="store.redo()"
                  >Redo</UiButton
                >
                <UiButton
                  v-if="selectedEdge && !store.positionDriven"
                  size="sm"
                  variant="outline-danger"
                  @click="removeSelectedEdge"
                  >Remove connection</UiButton
                >
              </div>
            </div>
          </template>
          <div class="te__canvas" @keydown="onEditorKeydown">
            <SequenceConversion
              v-if="!store.positionDriven && store.draft.nodes.length > 0"
              :preview="store.conversionPreview()"
              :names="nodeNames"
              @apply="store.enableSequencing()"
            />
            <FlowCanvas
              :nodes="store.draft.nodes"
              :edges="store.draft.edges"
              :selected-id="store.selectedId"
              :invalid-ids="invalidIds"
              :sequence-mode="store.positionDriven"
              @select="store.selectedId = $event"
              @select-edge="selectedEdge = $event"
              @connect="onConnect"
              @rejected="rejection = $event"
              @drop="onDrop"
              @move="store.moveStep"
            />
            <p
              v-if="store.positionDriven"
              class="td-small td-muted te__help"
              data-testid="canvas-help"
            >
              Drag a Step up or down to change the order; it takes its new place once it passes the
              middle of its neighbour. Connections follow automatically. Prefer the keyboard? Select
              a Step and press Alt+↑ or Alt+↓, or use the buttons in the Order list. Ctrl+Z undoes
              and Ctrl+Y redoes until you save.
            </p>
            <p v-else class="td-small td-muted te__help">
              Drag from a Step's bottom handle to another Step's top handle to connect them. Steps
              run strictly one after another; branches and loops are not available.
            </p>
          </div>
        </UiCard>

        <UiCard title="Variables">
          <template #actions>
            <UiIconButton
              size="sm"
              icon="help-circle"
              label="Help: Variables"
              data-testid="variables-help-button"
              @click="helpOpen = true"
            />
          </template>
          <div class="td-field">
            <label for="variables" class="td-label">JSON object</label>
            <CodeEditor
              id="variables"
              :model-value="variablesText"
              :min-lines="4"
              :invalid="Boolean(variablesError)"
              @update:model-value="onVariables"
            />
            <div v-if="variablesError" class="td-error" role="alert">
              {{ variablesError }}
            </div>
            <div v-else class="td-hint">
              Reference these as <code v-pre>{{ variables.name }}</code
              >. A value may itself use <code v-pre>{{testData…}}</code> or
              <code v-pre>{{environment…}}</code
              >.
            </div>
          </div>
        </UiCard>

        <UiCard title="Helpers" data-testid="test-helpers">
          <MockApiHelper v-model="store.draft.mockSetupIds" level="Test" />
        </UiCard>
      </div>

      <div class="te__col te__col--right">
        <UiCard>
          <StepInspector
            v-if="store.selected"
            :key="store.selected.id"
            :node="store.selected"
            :step-type="selectedType"
            :previous="previousIds"
            :server-errors="selectedIssues?.parameters"
            :environment-targets="validationEnvironmentTargets"
            @update="store.updateStep(store.selected.id, $event)"
            @remove="store.removeStep(store.selected.id)"
          />
          <EmptyState
            v-else
            title="No Step selected"
            description="Select a Step on the canvas or in the list to configure it."
          />
          <ul v-if="selectedIssues?.other.length" class="te__bad td-small">
            <li v-for="message in selectedIssues.other" :key="message">{{ message }}</li>
          </ul>
        </UiCard>
      </div>
    </div>
  </div>

  <UiDrawer v-model="helpOpen" title="Variables" size="md" data-testid="variables-help-panel">
    <VariablesHelp />
  </UiDrawer>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import { useQueryClient } from '@tanstack/vue-query'
import UiAlert from '~/components/ui/UiAlert.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiDrawer from '~/components/ui/UiDrawer.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import PageHeader from '~/components/PageHeader.vue'
import EmptyState from '~/components/platform/EmptyState.vue'
import FlowCanvas from '~/components/platform/FlowCanvas.vue'
import CodeEditor from '~/components/platform/CodeEditor.vue'
import LoadingState from '~/components/platform/LoadingState.vue'
import MockApiHelper from '~/components/platform/MockApiHelper.vue'
import ProblemAlert from '~/components/platform/ProblemAlert.vue'
import SequenceConversion from '~/components/platform/SequenceConversion.vue'
import StepInspector from '~/components/platform/StepInspector.vue'
import StepOrderList from '~/components/platform/StepOrderList.vue'
import VariablesHelp from '~/components/platform/VariablesHelp.vue'
import Icon from '~/components/ui/Icon.vue'
import { problemIssues } from '~/api/client'
import {
  testsApi,
  validateTestDraft,
  warningCodes,
  type TestValidationReport,
} from '~/api/platform'
import { useEnvironmentStore } from '~/stores/environment'
import { keys, useAsset, useEnvironments, useStepTypes } from '~/api/queries'
import type { JsonValue, TestDefinition, TestEdge, ValidationIssue } from '~/api/types'
import { mapIssues } from '~/components/platform/issue-map'
import { useEditorStore } from '~/stores/editor'

const store = useEditorStore()
const route = useRoute()
const router = useRouter()
const client = useQueryClient()

const routeId = computed(() => (route.params.id as string | undefined) || undefined)
const routeVersion = computed(() => (route.query.version ? Number(route.query.version) : undefined))

// --- loading -------------------------------------------------------------------------------
const {
  data: loaded,
  error: loadError,
  isPending,
  refetch,
} = useAsset('tests', routeId, routeVersion)
const loadingExisting = computed(() => Boolean(routeId.value) && isPending.value)

const {
  data: stepTypes,
  isPending: typesPending,
  error: typesError,
  refetch: refetchTypes,
} = useStepTypes()
const { data: environments } = useEnvironments()

const helpOpen = ref(false)
const variablesText = ref('{}')
const variablesError = ref('')
const tagsText = ref('')

const syncTexts = () => {
  variablesText.value = JSON.stringify(store.draft.variables, null, 2)
  variablesError.value = ''
  tagsText.value = store.draft.tags.join(', ')
}

watch(
  loaded,
  (asset) => {
    if (!asset) return
    const isDifferent = asset.id !== store.assetId
    const isNewer = asset.version !== store.version && !store.dirty
    if (isDifferent || isNewer) {
      store.load(asset as TestDefinition)
      syncTexts()
    }
  },
  { immediate: true },
)

// A new Test starts empty. This runs during setup, before the first render, so the previous
// Test's Steps are never shown.
if (!routeId.value) {
  store.reset()
  syncTexts()
}

// --- derived view state --------------------------------------------------------------------
const orderedNodes = computed(() => {
  const byId = new Map(store.draft.nodes.map((node) => [node.id, node]))
  return store.order.map((id) => byId.get(id)!)
})
const nodeNames = computed(() =>
  Object.fromEntries(store.draft.nodes.map((node) => [node.id, node.name])),
)
const selectedType = computed(() =>
  (stepTypes.value ?? []).find((type) => type.type === store.selected?.type),
)
const previousIds = computed(() => {
  const index = store.order.indexOf(store.selectedId ?? '')
  return index > 0 ? store.order.slice(0, index) : []
})

// --- server feedback -----------------------------------------------------------------------
const serverIssues = ref<ValidationIssue[]>([])
const validationResult = ref<TestValidationReport>()
const saveError = ref<unknown>()
const mapped = computed(() => mapIssues(serverIssues.value, store.draft.nodes))
const selectedIssues = computed(() =>
  store.selectedId ? mapped.value.byNode[store.selectedId] : undefined,
)
const invalidIds = computed(() => [
  ...new Set([
    ...store.clientIssues.flatMap((issue) => (issue.nodeId ? [issue.nodeId] : [])),
    ...Object.keys(mapped.value.byNode),
  ]),
])

// Edits make previous server feedback stale.
watch(
  () => store.draft,
  () => {
    serverIssues.value = []
    validationResult.value = undefined
  },
  { deep: true },
)

const orderNotice = ref('')
const saving = ref(false)
const validating = ref(false)
const environmentStore = useEnvironmentStore()
const selectedEnvironment = computed(() =>
  environments.value?.find((env) => env.id === environmentStore.selectedId),
)
const validationEnvironmentTargets = computed(() => selectedEnvironment.value?.targets)

const save = async () => {
  saving.value = true
  saveError.value = undefined
  try {
    const body = store.toRequestBody()
    let response: Response | undefined
    const options = { onResponse: (r: Response) => (response = r) }
    const asset =
      store.assetId && store.version
        ? await testsApi.update(store.assetId, { ...body, version: store.version }, options)
        : await testsApi.create(body, options)
    // The saved result is authoritative: its order, connections and settings replace the preview.
    store.markSaved(asset)
    orderNotice.value = warningCodes(response).includes('FLOW_ORDER_CHANGED')
      ? 'The server recalculated the order of the Steps from their positions and regenerated the connections. The canvas now shows the saved result.'
      : ''
    serverIssues.value = []
    await client.invalidateQueries({ queryKey: keys.tests })
    if (!routeId.value) await router.replace(`/tests/${asset.id}`)
  } catch (error) {
    saveError.value = error
    serverIssues.value = problemIssues(error)
  } finally {
    saving.value = false
  }
}

const validateOnServer = async () => {
  if (!store.assetId) return
  validating.value = true
  saveError.value = undefined
  try {
    const report = await validateTestDraft(
      store.assetId,
      store.toRequestBody(),
      environmentStore.selectedId || undefined,
    )
    validationResult.value = report
    serverIssues.value = report.issues
  } catch (error) {
    saveError.value = error
  } finally {
    validating.value = false
  }
}

// --- editing helpers -----------------------------------------------------------------------
const rejection = ref('')
const selectedEdge = ref<TestEdge>()

const onConnect = (from: string, to: string) => {
  const check = store.connect(from, to)
  rejection.value = check.ok ? '' : check.reason
}
const onDrop = (id: string, position: { x: number; y: number }, height: number) => {
  store.dropStep(id, position, height)
}

/** Ctrl+Z / Ctrl+Y inside the sequence area; form fields keep their own undo. */
const onEditorKeydown = (event: KeyboardEvent) => {
  if (!(event.ctrlKey || event.metaKey)) return
  const target = event.target as HTMLElement
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
  const key = event.key.toLowerCase()
  if (key === 'z' && !event.shiftKey) {
    event.preventDefault()
    store.undo()
  } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
    event.preventDefault()
    store.redo()
  }
}

const removeSelectedEdge = () => {
  if (selectedEdge.value) store.disconnect(selectedEdge.value.from, selectedEdge.value.to)
  selectedEdge.value = undefined
}

const onTags = (text: string) => {
  tagsText.value = text
  store.draft.tags = [
    ...new Set(
      text
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ]
}

const onVariables = (text: string) => {
  variablesText.value = text
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new Error('not an object')
    store.draft.variables = parsed as Record<string, JsonValue>
    variablesError.value = ''
  } catch {
    variablesError.value = 'Variables must be a valid JSON object.'
  }
}

// --- unsaved changes -----------------------------------------------------------------------
const confirmLeave = () =>
  !store.dirty || window.confirm('You have unsaved changes. Leave without saving?')
onBeforeRouteLeave(confirmLeave)
onBeforeRouteUpdate(confirmLeave)
const warnBeforeUnload = (event: BeforeUnloadEvent) => {
  if (store.dirty) event.preventDefault()
}
window.addEventListener('beforeunload', warnBeforeUnload)
onBeforeUnmount(() => window.removeEventListener('beforeunload', warnBeforeUnload))
</script>

<style scoped>
.te {
  display: flex;
  flex-direction: column;
  gap: var(--td-space-4);
}
.te__top {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--td-space-4);
}
.te__fields {
  flex: 1 1 32rem;
}
.te__actions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--td-space-1);
}
.te__list {
  margin: var(--td-space-2) 0 0;
  padding-left: var(--td-space-5);
}
.te__issues-title {
  font-weight: 650;
}
.te__grid {
  display: grid;
  grid-template-columns: minmax(13rem, 15rem) minmax(0, 1fr) minmax(18rem, 24rem);
  gap: var(--td-space-4);
  align-items: start;
}
.te__col {
  display: flex;
  flex-direction: column;
  gap: var(--td-space-4);
  min-width: 0;
}
@media (max-width: 87.99rem) {
  .te__grid {
    grid-template-columns: minmax(13rem, 15rem) minmax(0, 1fr);
  }
  .te__col--right {
    grid-column: 1 / -1;
  }
}
@media (max-width: 63.99rem) {
  .te__grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
.te__palette {
  display: flex;
  flex-direction: column;
  gap: var(--td-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.te__palette-btn {
  justify-content: flex-start;
}
.te__seq-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--td-space-2);
  width: 100%;
}
.te__seq-title {
  display: inline-flex;
  align-items: center;
  gap: var(--td-space-2);
  font-weight: 650;
}
.te__seq-buttons {
  gap: var(--td-space-1);
}
.te__help {
  margin: var(--td-space-2) 0 0;
}
.te__bad {
  margin: var(--td-space-2) 0 0;
  padding-left: var(--td-space-5);
  color: var(--td-danger);
}
</style>
