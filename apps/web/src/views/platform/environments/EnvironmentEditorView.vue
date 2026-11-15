<template>
  <PageHeader
    :title="isNew ? 'New Environment' : 'Edit Environment'"
    subtitle="Environments"
    subtitle-url="/environments"
  />

  <LoadingState v-if="isPending" label="Loading Environment" />
  <template v-else>
    <ProblemAlert :error="loadError" retryable @retry="() => refetch()" />
    <EmptyState
      v-if="!loadError && !isNew && !draft"
      title="Environment not found"
      description="It may have been deleted or renamed."
    >
      <UiButton to="/environments" variant="outline-primary" size="sm"
        >Back to Environments</UiButton
      >
    </EmptyState>

    <form v-else-if="draft" class="form" data-testid="environment-form" @submit.prevent="save">
      <ProblemAlert :error="saveError" />
      <UiAlert v-if="conflict" variant="warning" data-testid="environment-conflict">
        The Environment configuration changed since you opened it (a hand edit or another tab).
        <UiButton size="sm" variant="outline-secondary" @click="reload">Reload it</UiButton>
        and apply your change again.
      </UiAlert>
      <UiAlert v-if="generalIssues.length > 0 && attempted" variant="danger">
        <ul class="form__issues">
          <li v-for="(issue, index) in generalIssues" :key="index">{{ issue.message }}</li>
        </ul>
      </UiAlert>

      <UiCard title="Details">
        <div class="td-form-grid" style="--td-col: 12rem">
          <div class="td-field">
            <label for="env-id" class="td-label">Id</label>
            <input
              id="env-id"
              v-model.trim="draft.id"
              class="td-control"
              :disabled="!isNew"
              maxlength="63"
              autocomplete="off"
              placeholder="orders-test"
            />
            <div class="td-hint">
              {{
                isNew
                  ? 'Lower-case letters, digits and "-". It cannot be changed later.'
                  : 'The id cannot be changed.'
              }}
            </div>
          </div>
          <div class="td-field">
            <label for="env-name" class="td-label">Name</label>
            <input
              id="env-name"
              v-model="draft.name"
              class="td-control"
              autocomplete="off"
              placeholder="Orders test"
            />
          </div>
          <div class="td-field">
            <label for="env-class" class="td-label">Classification</label>
            <select id="env-class" v-model="draft.classification" class="td-control">
              <option v-for="item in CLASSIFICATIONS" :key="item" :value="item">
                {{ item }}
              </option>
            </select>
          </div>
        </div>
        <p class="td-small td-muted form__note" data-testid="classification-note">
          <template v-if="allowPlainText">
            Plain-text local secrets are allowed in LOCAL and TEST Environments. Key Vault
            references are always allowed.
          </template>
          <template v-else>
            {{ draft.classification }} Environments must use <strong>Key Vault</strong> references
            only; local plain-text secrets are not accepted.
          </template>
        </p>
      </UiCard>

      <UiCard title="Limits (optional)">
        <div class="td-form-grid" style="--td-col: 11rem">
          <div v-for="field in LIMIT_FIELDS" :key="field.key" class="td-field">
            <label :for="`limit-${field.key}`" class="td-label">{{ field.label }}</label>
            <input
              :id="`limit-${field.key}`"
              v-model.trim="draft.limits[field.key]"
              class="td-control td-control--sm"
              inputmode="numeric"
              autocomplete="off"
            />
          </div>
        </div>
      </UiCard>

      <UiCard title="Values">
        <template #actions>
          <UiButton size="sm" variant="outline-secondary" @click="addValue">
            <Icon name="plus" :size="14" />Add value
          </UiButton>
        </template>
        <p class="td-small td-muted form__note">
          Non-secret values Tests can read as <code v-pre>{{ environment.name }}</code
          >. Never put a secret here.
        </p>
        <div v-for="row in draft.values" :key="row.uid" class="value-row">
          <input
            v-model.trim="row.key"
            class="td-control td-control--sm"
            aria-label="Value name"
            placeholder="region"
            autocomplete="off"
          />
          <input
            v-model="row.value"
            class="td-control td-control--sm"
            aria-label="Value"
            placeholder="eu"
            autocomplete="off"
          />
          <UiIconButton
            size="sm"
            variant="outline-secondary"
            icon="x"
            label="Remove value"
            @click="removeValue(row.uid)"
          />
        </div>
        <p v-if="draft.values.length === 0" class="td-small td-muted td-mb-0">No values.</p>
      </UiCard>

      <section class="targets">
        <div class="targets__head">
          <h2>Targets</h2>
          <div class="td-row">
            <UiButton
              v-for="kind in TARGET_KINDS"
              :key="kind.value"
              size="sm"
              variant="outline-primary"
              :data-testid="`add-target-${kind.value}`"
              @click="addTarget(kind.value)"
            >
              <Icon name="plus" :size="14" />{{ kind.label }}
            </UiButton>
          </div>
        </div>
        <p v-if="draft.targets.length === 0" class="td-small td-muted">
          No targets yet. Add the systems Tests may call.
        </p>
        <TargetEditor
          v-for="(target, index) in draft.targets"
          :key="target.uid"
          v-model="draft.targets[index]!"
          :allow-plain-text="allowPlainText"
          :known-local-names="knownLocalNames"
          :set-local-names="setLocalNames"
          :issues="issuesByTarget.get(target.uid) ?? []"
          @remove="draft.targets.splice(index, 1)"
        />
      </section>

      <div class="td-form-actions">
        <UiButton type="submit" variant="primary" :loading="saving" data-testid="save-environment">
          {{ saving ? 'Saving…' : 'Save' }}
        </UiButton>
        <UiButton to="/environments" variant="outline-secondary">Cancel</UiButton>
      </div>
    </form>
  </template>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PageHeader from '~/components/PageHeader.vue'
import EmptyState from '~/components/platform/EmptyState.vue'
import LoadingState from '~/components/platform/LoadingState.vue'
import ProblemAlert from '~/components/platform/ProblemAlert.vue'
import TargetEditor from '~/components/platform/TargetEditor.vue'
import Icon from '~/components/ui/Icon.vue'
import UiAlert from '~/components/ui/UiAlert.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import { ApiError, problemIssues } from '~/api/client'
import { describeIssuePath } from '~/components/platform/problem'
import {
  useEnvironmentConfigMutations,
  useEnvironmentConfigs,
  useSecretsOverview,
} from '~/api/queries'
import type { TargetKind } from '~/api/types'
import {
  CLASSIFICATIONS,
  LIMIT_FIELDS,
  TARGET_KINDS,
  allowsPlainText as allowsPlainTextFor,
  blankEnvironment,
  blankTarget,
  draftIssues,
  fromDraft,
  isRelevantTargetIssue,
  targetOfIssue,
  toDraft,
  uid,
  type EnvironmentDraft,
} from '~/components/platform/environment-form'

const route = useRoute()
const router = useRouter()
const { data, isPending, error: loadError, refetch } = useEnvironmentConfigs()
const { data: secrets } = useSecretsOverview()
const mutations = useEnvironmentConfigMutations()

const isNew = computed(() => route.name === 'platform.environments.new')
const draft = ref<EnvironmentDraft>()
const attempted = ref(false)

// Build the form once the Environment list is available (and again after an explicit reload).
const initialise = () => {
  if (!data.value) return
  if (isNew.value) {
    draft.value = blankEnvironment()
    return
  }
  const found = data.value.items.find((item) => item.id === route.params.id)
  draft.value = found ? toDraft(found) : undefined
}
watch(() => [data.value?.revision === undefined, route.params.id, isNew.value], initialise, {
  immediate: true,
})

const reload = async () => {
  await refetch()
  attempted.value = false
  mutations.update.reset()
  mutations.create.reset()
  initialise()
}

const allowPlainText = computed(() => allowsPlainTextFor(draft.value?.classification ?? 'TEST'))
const knownLocalNames = computed(() => (secrets.value?.local ?? []).map((entry) => entry.name))
const setLocalNames = computed(() =>
  (secrets.value?.local ?? [])
    .filter((entry) => entry.source !== 'missing')
    .map((entry) => entry.name),
)

const clientIssues = computed(() =>
  draft.value ? draftIssues(draft.value, { isNew: isNew.value }) : [],
)

/** Problems not tied to one target; those appear on their own target card instead. */
const generalIssues = computed(() =>
  clientIssues.value.filter((issue) => issue.targetUid === undefined),
)

const saving = computed(() => mutations.create.isPending.value || mutations.update.isPending.value)
const saveError = computed(() => mutations.create.error.value ?? mutations.update.error.value)
const conflict = computed(
  () =>
    saveError.value instanceof ApiError &&
    saveError.value.status === 409 &&
    /changed/.test(saveError.value.message),
)
/** Messages per target card, from the server's last answer and (after a save attempt) the form checks. */
const issuesByTarget = computed(() => {
  const map = new Map<number, string[]>()
  const add = (uid: number, message: string) => map.set(uid, [...(map.get(uid) ?? []), message])
  for (const issue of problemIssues(saveError.value)) {
    const name = targetOfIssue(issue.path)
    const target = name ? draft.value?.targets.find((item) => item.name.trim() === name) : undefined
    if (!target || !isRelevantTargetIssue(target.kind, issue.path, issue.message)) continue
    const field = describeIssuePath(issue.path.replace(/^\/targets\/[^/]+/, ''))
    add(target.uid, field === 'Test' ? issue.message : `${field}: ${issue.message}`)
  }
  if (attempted.value)
    for (const issue of clientIssues.value)
      if (issue.targetUid !== undefined) add(issue.targetUid, issue.message)
  return map
})

const addTarget = (kind: TargetKind) => draft.value?.targets.push(blankTarget(kind))
const addValue = () => draft.value?.values.push({ uid: uid(), key: '', value: '' })
const removeValue = (id: number) => {
  if (draft.value) draft.value.values = draft.value.values.filter((row) => row.uid !== id)
}

const save = () => {
  if (!draft.value || !data.value) return
  attempted.value = true
  if (clientIssues.value.length > 0) return
  const environment = fromDraft(draft.value)
  const done = () => router.push('/environments')
  if (isNew.value)
    mutations.create.mutate({ environment, revision: data.value.revision }, { onSuccess: done })
  else mutations.update.mutate({ environment, revision: data.value.revision }, { onSuccess: done })
}
</script>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: var(--td-space-4);
}
.form__issues {
  margin: 0;
  padding-left: var(--td-space-5);
}
.form__note {
  margin: var(--td-space-3) 0 0;
}
.value-row {
  display: grid;
  grid-template-columns: minmax(8rem, 1fr) minmax(10rem, 2fr) auto;
  gap: var(--td-space-2);
  margin-bottom: var(--td-space-2);
}
.targets__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--td-space-3);
  margin-bottom: var(--td-space-3);
}
.targets__head h2 {
  margin: 0;
}
</style>
