<template>
  <PageHeader
    :title="id ? 'Edit Mock API setup' : 'New Mock API setup'"
    subtitle="Mock API"
    subtitle-url="/mock-api"
  />

  <LoadingState v-if="editor.loading.value" label="Loading setup…" />
  <ProblemAlert
    v-else-if="editor.loadError.value"
    :error="editor.loadError.value"
    retryable
    @retry="() => editor.refetch()"
  />

  <div v-else class="setup">
    <MockApiAddress />

    <UiCard data-testid="mock-setup-editor">
      <div class="td-form-grid" style="--td-col: 18rem">
        <div class="td-field">
          <label for="ms-name" class="td-label">Name</label>
          <input
            id="ms-name"
            v-model="name"
            class="td-control"
            maxlength="200"
            required
            :aria-invalid="submitted && name.trim() === ''"
          />
          <div v-if="submitted && name.trim() === ''" class="td-error" role="alert">
            A name is required to save the setup.
          </div>
        </div>
        <div class="td-field">
          <label for="ms-tags" class="td-label">Tags</label>
          <input
            id="ms-tags"
            class="td-control"
            placeholder="comma separated"
            :value="tags.join(', ')"
            @input="onTags(($event.target as HTMLInputElement).value)"
          />
        </div>
      </div>
      <div class="td-field setup__desc">
        <label for="ms-description" class="td-label">Description</label>
        <input id="ms-description" v-model="description" class="td-control" maxlength="2000" />
      </div>
    </UiCard>

    <UiCard title="Rules">
      <template #actions>
        <span class="td-muted td-small">The first rule that matches a request answers it.</span>
        <UiButton
          size="sm"
          variant="outline-primary"
          data-testid="add-rule"
          @click="rules.push(blankRule())"
        >
          <Icon name="plus" :size="14" />Add rule
        </UiButton>
      </template>

      <p class="td-small td-muted setup__help">
        A path is a regular expression for the whole request path. It is anchored, so
        <code>/orders</code> does not match <code>/orders/1</code>. Examples:
        <code>/orders/[0-9]+</code>, <code>/users/[^/]+/items</code>, <code>/files/.*</code>. To
        match the query string too, add it after a <code>?</code>, for example
        <code>/v1/Service?$filter=LocationId eq '[0-9]+'</code>. The query is matched as sent and as
        decoded (<code>%20</code> as a space), and a <code>$</code> before a letter is taken
        literally. Without a query part, the query string is ignored.
      </p>

      <EmptyState
        v-if="rules.length === 0"
        title="No rules yet"
        description="Add a rule to map a path to a response."
      />

      <div
        v-for="(rule, index) in rules"
        :key="rule.uid"
        class="rule"
        :data-testid="`rule-${index}`"
      >
        <div class="rule__grid">
          <div class="td-field rule__name">
            <label :for="`rule-${rule.uid}-name`" class="td-hint">Label (optional)</label>
            <input
              :id="`rule-${rule.uid}-name`"
              v-model="rule.name"
              class="td-control td-control--sm"
              maxlength="200"
              placeholder="Look up a payment"
            />
          </div>
          <div class="td-field rule__method">
            <label :for="`rule-${rule.uid}-method`" class="td-hint">Method</label>
            <select
              :id="`rule-${rule.uid}-method`"
              v-model="rule.method"
              class="td-control td-control--sm"
            >
              <option value="">Any</option>
              <option v-for="method in MOCK_RULE_METHODS" :key="method" :value="method">
                {{ method }}
              </option>
            </select>
          </div>
          <div class="td-field rule__path">
            <label :for="`rule-${rule.uid}-path`" class="td-hint">Path (regular expression)</label>
            <input
              :id="`rule-${rule.uid}-path`"
              v-model="rule.path"
              class="td-control td-control--sm td-mono"
              spellcheck="false"
              autocomplete="off"
              placeholder="/payments/[0-9]+"
              :aria-invalid="Boolean(issuesOf(rule).path)"
            />
            <div v-if="issuesOf(rule).path" class="td-error" role="alert">
              {{ issuesOf(rule).path }}
            </div>
          </div>
          <div class="td-field rule__status">
            <label :for="`rule-${rule.uid}-status`" class="td-hint">Status code</label>
            <input
              :id="`rule-${rule.uid}-status`"
              v-model="rule.status"
              class="td-control td-control--sm"
              inputmode="numeric"
              autocomplete="off"
              :aria-invalid="Boolean(issuesOf(rule).status)"
            />
            <div v-if="issuesOf(rule).status" class="td-error" role="alert">
              {{ issuesOf(rule).status }}
            </div>
          </div>
          <div class="td-field rule__body">
            <label :for="`rule-${rule.uid}-body`" class="td-hint"
              >Response body (JSON, optional)</label
            >
            <CodeEditor
              :id="`rule-${rule.uid}-body`"
              v-model="rule.bodyText"
              small
              :min-lines="4"
              :invalid="Boolean(issuesOf(rule).body)"
            />
            <div v-if="issuesOf(rule).body" class="td-error" role="alert">
              {{ issuesOf(rule).body }}
            </div>
          </div>
        </div>
        <div class="rule__actions">
          <UiButton
            size="sm"
            variant="outline-secondary"
            :disabled="index === 0"
            :aria-label="`Move rule ${index + 1} up`"
            @click="move(index, -1)"
            >↑</UiButton
          >
          <UiButton
            size="sm"
            variant="outline-secondary"
            :disabled="index === rules.length - 1"
            :aria-label="`Move rule ${index + 1} down`"
            @click="move(index, 1)"
            >↓</UiButton
          >
          <UiButton
            size="sm"
            variant="outline-danger"
            :aria-label="`Remove rule ${index + 1}`"
            @click="rules.splice(index, 1)"
            >Remove</UiButton
          >
        </div>
      </div>
    </UiCard>

    <UiCard title="Try a request" data-testid="rule-tester">
      <div class="try">
        <div class="td-field">
          <label for="try-method" class="td-hint">Method</label>
          <select id="try-method" v-model="tryMethod" class="td-control td-control--sm">
            <option v-for="method in MOCK_RULE_METHODS" :key="method" :value="method">
              {{ method }}
            </option>
          </select>
        </div>
        <div class="td-field">
          <label for="try-path" class="td-hint">Path</label>
          <input
            id="try-path"
            v-model="tryPath"
            class="td-control td-control--sm td-mono"
            spellcheck="false"
            autocomplete="off"
            placeholder="/payments/42"
          />
        </div>
      </div>
      <p v-if="tryPath.trim() !== ''" class="setup__result" data-testid="try-result">
        <template v-if="tryIndex >= 0">
          Answered by rule {{ tryIndex + 1
          }}<template v-if="rules[tryIndex]?.name"> “{{ rules[tryIndex]?.name }}”</template> with
          status <strong>{{ rules[tryIndex]?.status }}</strong
          >.
        </template>
        <template v-else>No rule matches; the server would answer 404.</template>
      </p>
    </UiCard>

    <ProblemAlert :error="editor.saveError.value" />

    <div class="td-row">
      <UiButton
        variant="primary"
        :disabled="editor.saving.value || !editor.dirty.value"
        data-testid="save-mock-setup"
        @click="save"
      >
        {{ editor.saving.value ? 'Saving…' : 'Save' }}
      </UiButton>
      <UiButton to="/mock-api" variant="outline-secondary">Back</UiButton>
      <UiBadge v-if="editor.dirty.value" variant="warning">Unsaved changes</UiBadge>
      <UiBadge v-else-if="editor.version.value" variant="success"
        >Saved · v{{ editor.version.value }}</UiBadge
      >
    </div>
    <ul
      v-if="submitted && blockers.length > 0"
      class="setup__blockers td-small"
      data-testid="save-blockers"
      role="alert"
    >
      <li v-for="reason in blockers" :key="reason">{{ reason }}</li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import PageHeader from '~/components/PageHeader.vue'
import EmptyState from '~/components/platform/EmptyState.vue'
import CodeEditor from '~/components/platform/CodeEditor.vue'
import LoadingState from '~/components/platform/LoadingState.vue'
import MockApiAddress from '~/components/platform/MockApiAddress.vue'
import ProblemAlert from '~/components/platform/ProblemAlert.vue'
import Icon from '~/components/ui/Icon.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiCard from '~/components/ui/UiCard.vue'
import { useAssetEditor } from '~/components/platform/useAssetEditor'
import {
  MOCK_RULE_METHODS,
  blankRule,
  firstMatch,
  fromRule,
  requestParts,
  ruleIssues,
  toRule,
  type RuleDraft,
} from '~/components/platform/mock-setup'
import type { MockSetupAsset } from '~/api/types'

const route = useRoute()
const id = computed(() => (route.params.id as string | undefined) || undefined)

const name = ref('')
const description = ref('')
const tags = ref<string[]>([])
const rules = reactive<RuleDraft[]>([])

const tryMethod = ref('GET')
const tryPath = ref('')
const tryIndex = computed(() => {
  const { path, query } = requestParts(tryPath.value)
  return firstMatch(rules, tryMethod.value, path, query)
})

const issuesOf = (rule: RuleDraft) => ruleIssues(rule)

const editor = useAssetEditor<MockSetupAsset>({
  kind: 'mockSetups',
  basePath: '/mock-api',
  id,
  apply: (asset) => {
    name.value = asset.name
    description.value = asset.description ?? ''
    tags.value = [...asset.tags]
    rules.splice(0, rules.length, ...asset.rules.map(fromRule))
  },
  reset: () => {
    name.value = ''
    description.value = ''
    tags.value = []
    rules.splice(0, rules.length, blankRule())
  },
  body: () => ({
    name: name.value.trim(),
    ...(description.value.trim() ? { description: description.value.trim() } : {}),
    tags: tags.value,
    rules: rules.map(toRule),
  }),
})

/** Why the setup cannot be saved yet; shown beside the Save button. */
const blockers = computed(() => {
  const reasons: string[] = []
  if (name.value.trim() === '') reasons.push('Enter a name for the setup.')
  if (rules.length === 0) reasons.push('Add at least one rule.')
  rules.forEach((rule, index) => {
    const found = ruleIssues(rule)
    for (const message of [found.path, found.status, found.body])
      if (message) reasons.push(`Rule ${index + 1}: ${message}`)
  })
  return reasons
})

// Problems are reported once Save has been clicked, not while the form is still being filled in.
const submitted = ref(false)
const save = () => {
  submitted.value = true
  if (blockers.value.length === 0) void editor.save()
}

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
  const [rule] = rules.splice(index, 1)
  if (rule) rules.splice(index + delta, 0, rule)
}
</script>

<style scoped>
.setup {
  display: flex;
  flex-direction: column;
  gap: var(--td-space-4);
}
.setup__desc {
  margin-top: var(--td-space-4);
}
.setup__help {
  margin: 0 0 var(--td-space-4);
}
.setup__result {
  margin: var(--td-space-3) 0 0;
}
.setup__blockers {
  margin: 0;
  padding-left: var(--td-space-5);
  color: var(--td-danger);
}
.rule {
  margin-bottom: var(--td-space-3);
  padding: var(--td-space-4);
  background: var(--td-surface-2);
  border: 1px solid var(--td-border);
  border-radius: var(--td-radius-md);
}
.rule__grid {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: var(--td-space-3);
}
.rule__name {
  grid-column: span 3;
}
.rule__method {
  grid-column: span 2;
}
.rule__path {
  grid-column: span 5;
}
.rule__status {
  grid-column: span 2;
}
.rule__body {
  grid-column: 1 / -1;
}
@media (max-width: 63.99rem) {
  .rule__name,
  .rule__method,
  .rule__path,
  .rule__status {
    grid-column: 1 / -1;
  }
}
.rule__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--td-space-1);
  margin-top: var(--td-space-3);
}
.try {
  display: grid;
  grid-template-columns: 8rem minmax(0, 28rem);
  gap: var(--td-space-3);
}
@media (max-width: 47.99rem) {
  .try {
    grid-template-columns: 1fr;
  }
}
</style>
