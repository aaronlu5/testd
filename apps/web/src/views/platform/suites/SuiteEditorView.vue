<template>
  <PageHeader :title="id ? 'Edit Suite' : 'New Suite'" subtitle="Suites" subtitle-url="/suites" />

  <LoadingState v-if="editor.loading.value" label="Loading Suite…" />
  <ProblemAlert
    v-else-if="editor.loadError.value"
    :error="editor.loadError.value"
    retryable
    @retry="() => editor.refetch()"
  />

  <UiCard v-else data-testid="suite-editor">
    <div class="se">
      <div class="td-form-grid" style="--td-col: 18rem">
        <div class="td-field">
          <label for="suite-name" class="td-label">Name</label>
          <input id="suite-name" v-model="name" class="td-control" maxlength="200" />
        </div>
        <div class="td-field">
          <label for="suite-tags" class="td-label">Tags</label>
          <input
            id="suite-tags"
            class="td-control"
            placeholder="comma separated"
            :value="tags.join(', ')"
            @input="onTags(($event.target as HTMLInputElement).value)"
          />
        </div>
        <div class="td-field">
          <label for="suite-concurrency" class="td-label">Concurrency (optional)</label>
          <input
            id="suite-concurrency"
            v-model="concurrencyText"
            class="td-control"
            type="number"
            inputmode="numeric"
            min="1"
            max="64"
            step="1"
            aria-describedby="suite-concurrency-help"
            data-testid="suite-concurrency-input"
          />
          <div id="suite-concurrency-help" class="td-hint">
            How many items may run at once. Blank means one at a time. The Environment you run in
            sets the upper limit.
          </div>
        </div>
      </div>
      <div class="td-field">
        <label for="suite-description" class="td-label">Description</label>
        <input id="suite-description" v-model="description" class="td-control" maxlength="2000" />
      </div>

      <div class="se__box" data-testid="suite-helpers">
        <h2>Helpers</h2>
        <MockApiHelper v-model="mockSetupIds" level="Suite" />
      </div>

      <ProblemAlert :error="listError" retryable @retry="refetchLists" />

      <div>
        <h2>Items (run in order)</h2>
        <EmptyState
          v-if="items.length === 0"
          title="No items yet"
          description="Add a Test and the Test Data to run it with."
        />
        <ol v-else class="se__items" data-testid="suite-items">
          <li v-for="(item, index) in items" :key="index" class="se__item">
            <div class="td-field">
              <label :for="`item-test-${index}`" class="td-hint">Test</label>
              <select :id="`item-test-${index}`" v-model="item.testId" class="td-control">
                <option value="" disabled>Select a Test</option>
                <option v-for="test in tests ?? []" :key="test.id" :value="test.id">
                  {{ test.name }}
                </option>
              </select>
            </div>
            <div class="td-field">
              <label :for="`item-data-${index}`" class="td-hint">Test Data</label>
              <select :id="`item-data-${index}`" v-model="item.dataSetId" class="td-control">
                <option value="" disabled>Select Test Data</option>
                <option v-for="data in testData ?? []" :key="data.id" :value="data.id">
                  {{ data.name }}
                </option>
              </select>
            </div>
            <div class="se__item-actions">
              <UiButton
                size="sm"
                variant="outline-secondary"
                :disabled="index === 0"
                :aria-label="`Move item ${index + 1} up`"
                @click="move(index, -1)"
                >↑</UiButton
              >
              <UiButton
                size="sm"
                variant="outline-secondary"
                :disabled="index === items.length - 1"
                :aria-label="`Move item ${index + 1} down`"
                @click="move(index, 1)"
                >↓</UiButton
              >
              <UiButton
                size="sm"
                variant="outline-danger"
                :aria-label="`Remove item ${index + 1}`"
                @click="items.splice(index, 1)"
                >×</UiButton
              >
            </div>
          </li>
        </ol>
        <UiButton
          variant="outline-secondary"
          size="sm"
          @click="items.push({ testId: '', dataSetId: '' })"
        >
          <Icon name="plus" :size="14" /> Add item
        </UiButton>
      </div>

      <ProblemAlert :error="editor.saveError.value" />

      <div class="td-row">
        <UiButton
          variant="primary"
          :disabled="!canSave"
          data-testid="save-suite"
          @click="() => editor.save()"
        >
          {{ editor.saving.value ? 'Saving…' : 'Save' }}
        </UiButton>
        <UiButton
          v-if="id"
          :to="{ path: '/suite-runs/new', query: { suiteId: id } }"
          variant="outline-success"
          :disabled="editor.dirty.value"
          >Run</UiButton
        >
        <UiBadge v-if="editor.dirty.value" variant="warning">Unsaved changes</UiBadge>
        <UiBadge v-else-if="editor.version.value" variant="success"
          >Saved · v{{ editor.version.value }}</UiBadge
        >
      </div>
    </div>
  </UiCard>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiCard from '~/components/ui/UiCard.vue'
import PageHeader from '~/components/PageHeader.vue'
import EmptyState from '~/components/platform/EmptyState.vue'
import LoadingState from '~/components/platform/LoadingState.vue'
import MockApiHelper from '~/components/platform/MockApiHelper.vue'
import ProblemAlert from '~/components/platform/ProblemAlert.vue'
import { useAssetEditor } from '~/components/platform/useAssetEditor'
import Icon from '~/components/ui/Icon.vue'
import { useAssetList } from '~/api/queries'
import type { SuiteAsset } from '~/api/types'

const route = useRoute()
const id = computed(() => (route.params.id as string | undefined) || undefined)

const name = ref('')
const description = ref('')
const tags = ref<string[]>([])
const concurrencyText = ref('')
const mockSetupIds = ref<string[]>([])
const items = reactive<{ testId: string; dataSetId: string }[]>([])

const testsQuery = useAssetList('tests')
const dataQuery = useAssetList('testData')
const tests = computed(() => testsQuery.data.value)
const testData = computed(() => dataQuery.data.value)
const listError = computed(() => testsQuery.error.value ?? dataQuery.error.value)
const refetchLists = () => {
  void testsQuery.refetch()
  void dataQuery.refetch()
}

const concurrency = computed(() => {
  // A number input yields a number once the user types, so normalise to text first.
  const text = String(concurrencyText.value ?? '').trim()
  const value = Number(text)
  return text !== '' && Number.isInteger(value) && value >= 1 && value <= 64 ? value : undefined
})

const editor = useAssetEditor<SuiteAsset>({
  kind: 'suites',
  basePath: '/suites',
  id,
  apply: (asset) => {
    name.value = asset.name
    description.value = asset.description ?? ''
    tags.value = [...asset.tags]
    concurrencyText.value = asset.maxConcurrency ? String(asset.maxConcurrency) : ''
    mockSetupIds.value = [...(asset.helpers?.mockApi?.setupIds ?? [])]
    items.splice(0, items.length, ...asset.items.map((item) => ({ ...item })))
  },
  reset: () => {
    name.value = ''
    description.value = ''
    tags.value = []
    concurrencyText.value = ''
    mockSetupIds.value = []
    items.splice(0, items.length)
  },
  body: () => ({
    name: name.value.trim(),
    ...(description.value.trim() ? { description: description.value.trim() } : {}),
    tags: tags.value,
    items: items.map(({ testId, dataSetId }) => ({ testId, dataSetId })),
    ...(concurrency.value !== undefined ? { maxConcurrency: concurrency.value } : {}),
    ...(mockSetupIds.value.length > 0
      ? { helpers: { mockApi: { setupIds: mockSetupIds.value } } }
      : {}),
  }),
})

const canSave = computed(
  () =>
    !editor.saving.value &&
    name.value.trim() !== '' &&
    items.length > 0 &&
    items.every((item) => item.testId && item.dataSetId) &&
    editor.dirty.value,
)

const onTags = (text: string) => {
  tags.value = [
    ...new Set(
      text
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ]
}
const move = (index: number, delta: -1 | 1) => {
  const [item] = items.splice(index, 1)
  if (item) items.splice(index + delta, 0, item)
}
</script>

<style scoped>
.se {
  display: flex;
  flex-direction: column;
  gap: var(--td-space-4);
}
.se h2 {
  margin: 0 0 var(--td-space-2);
  font-size: var(--td-text-md);
}
.se__box {
  padding: var(--td-space-4);
  background: var(--td-surface-2);
  border: 1px solid var(--td-border);
  border-radius: var(--td-radius-md);
}
.se__items {
  display: flex;
  flex-direction: column;
  gap: var(--td-space-3);
  margin: 0 0 var(--td-space-3);
  padding: 0;
  list-style: none;
}
.se__item {
  display: grid;
  grid-template-columns: minmax(0, 5fr) minmax(0, 5fr) auto;
  align-items: end;
  gap: var(--td-space-2);
}
.se__item-actions {
  display: flex;
  gap: var(--td-space-1);
  white-space: nowrap;
}
@media (max-width: 47.99rem) {
  .se__item {
    grid-template-columns: 1fr;
  }
}
</style>
