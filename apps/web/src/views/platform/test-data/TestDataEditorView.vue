<template>
  <PageHeader
    :title="id ? 'Edit Test Data' : 'New Test Data'"
    subtitle="Test Data"
    subtitle-url="/test-data"
  />

  <LoadingState v-if="editor.loading.value" label="Loading Test Data…" />
  <ProblemAlert
    v-else-if="editor.loadError.value"
    :error="editor.loadError.value"
    retryable
    @retry="() => editor.refetch()"
  />

  <UiCard v-else data-testid="test-data-editor">
    <div class="editor">
      <div class="td-form-grid" style="--td-col: 18rem">
        <div class="td-field">
          <label for="td-name" class="td-label">Name</label>
          <input id="td-name" v-model="name" class="td-control" maxlength="200" />
        </div>
        <div class="td-field">
          <label for="td-tags" class="td-label">Tags</label>
          <input
            id="td-tags"
            class="td-control"
            placeholder="comma separated"
            :value="tags.join(', ')"
            @input="onTags(($event.target as HTMLInputElement).value)"
          />
        </div>
      </div>
      <div class="td-field">
        <label for="td-description" class="td-label">Description</label>
        <input id="td-description" v-model="description" class="td-control" maxlength="2000" />
      </div>
      <div class="td-field">
        <label for="td-json" class="td-label">Data (JSON object)</label>
        <CodeEditor
          id="td-json"
          v-model="json"
          :min-lines="14"
          :max-lines="40"
          :invalid="Boolean(clientError)"
          describedby="td-json-help"
        />
        <div id="td-json-help" class="td-hint">
          Tests read this through <code v-pre>{{ testData.path.to.value }}</code
          >. Do not store secrets here. Values can use global variables such as
          <code v-pre>{{ global.runNumber }}</code> to be different in every Run; see
          <RouterLink to="/references">References</RouterLink>.
        </div>
      </div>

      <UiAlert v-if="clientError" variant="danger" data-testid="json-error">
        {{ clientError }}
      </UiAlert>
      <UiAlert v-for="warning in warnings" :key="warning" variant="warning">
        {{ warning }}
      </UiAlert>
      <UiAlert v-if="checked && !clientError" variant="success" data-testid="json-valid">
        Valid JSON object ({{ keyCount }} top-level key(s)).
      </UiAlert>

      <ProblemAlert :error="editor.saveError.value" />

      <div class="td-row">
        <UiButton
          variant="primary"
          :disabled="!canSave"
          data-testid="save-test-data"
          @click="onSave"
        >
          {{ editor.saving.value ? 'Saving…' : 'Save' }}
        </UiButton>
        <UiButton variant="outline-primary" data-testid="validate-json" @click="validate"
          >Validate</UiButton
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
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import PageHeader from '~/components/PageHeader.vue'
import CodeEditor from '~/components/platform/CodeEditor.vue'
import LoadingState from '~/components/platform/LoadingState.vue'
import ProblemAlert from '~/components/platform/ProblemAlert.vue'
import UiAlert from '~/components/ui/UiAlert.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiCard from '~/components/ui/UiCard.vue'
import { useAssetEditor } from '~/components/platform/useAssetEditor'
import type { JsonObject, TestDataAsset } from '~/api/types'
import { parseJsonObject, sensitiveKeyWarnings } from '~/components/platform/json-object'

const route = useRoute()
const id = computed(() => (route.params.id as string | undefined) || undefined)

const name = ref('')
const description = ref('')
const tags = ref<string[]>([])
const json = ref('{}')
const checked = ref(false)

const parsed = computed(() => parseJsonObject(json.value))
const clientError = computed(() => (parsed.value.ok ? '' : parsed.value.error))
const keyCount = computed(() => (parsed.value.ok ? Object.keys(parsed.value.value).length : 0))
const warnings = computed(() => (parsed.value.ok ? sensitiveKeyWarnings(parsed.value.value) : []))

const editor = useAssetEditor<TestDataAsset>({
  kind: 'testData',
  basePath: '/test-data',
  id,
  apply: (asset) => {
    name.value = asset.name
    description.value = asset.description ?? ''
    tags.value = [...asset.tags]
    json.value = JSON.stringify(asset.data, null, 2)
  },
  reset: () => {
    name.value = ''
    description.value = ''
    tags.value = []
    json.value = '{\n  \n}'
  },
  body: () => ({
    name: name.value.trim(),
    ...(description.value.trim() ? { description: description.value.trim() } : {}),
    tags: tags.value,
    data: (parsed.value.ok ? parsed.value.value : {}) as JsonObject,
  }),
})

const canSave = computed(
  () => !editor.saving.value && name.value.trim() !== '' && parsed.value.ok && editor.dirty.value,
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
const validate = () => {
  checked.value = true
}
const onSave = async () => {
  checked.value = false
  await editor.save()
}
</script>

<style scoped>
.editor {
  display: flex;
  flex-direction: column;
  gap: var(--td-space-4);
}
</style>
