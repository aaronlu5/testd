<template>
  <PageHeader title="Secrets" subtitle="Configuration" />

  <UiAlert variant="info" class="secrets__note" data-testid="secrets-note">
    <strong>Values are write-only.</strong> You can set, replace or remove a secret here, but Testd
    never shows a stored value again. Local plain-text secrets are for local and test use only;
    STAGING and PRODUCTION Environments must use Key Vault references.
  </UiAlert>

  <ProblemAlert :error="error" retryable @retry="() => refetch()" />
  <ProblemAlert :error="actionError" />
  <UiAlert v-if="notice" variant="warning" dismissible @dismiss="notice = ''">
    {{ notice }}
  </UiAlert>
  <UiAlert v-if="overview && !overview.environmentsAvailable" variant="warning">
    The Environment file could not be read, so it cannot be shown where secrets are used.
  </UiAlert>

  <LoadingState v-if="isPending" label="Loading secrets" />
  <div v-else-if="overview" class="secrets">
    <UiCard flush data-testid="local-secrets">
      <template #header>
        <div>
          <div class="secrets__title">Local secrets (plain text)</div>
          <div class="td-small td-muted">
            Stored unencrypted in <code>{{ overview.secretsFile }}</code> on the machine running
            Testd (readable by its owner only). A <code>TEST_PLATFORM_SECRET_&lt;NAME&gt;</code>
            environment variable, if set, takes precedence.
          </div>
        </div>
      </template>

      <form class="secrets__add" data-testid="add-secret-form" @submit.prevent="add">
        <div class="secrets__add-grid">
          <div class="td-field">
            <label for="new-secret-name" class="td-label">Name</label>
            <input
              id="new-secret-name"
              v-model.trim="newName"
              class="td-control td-control--sm"
              maxlength="64"
              autocomplete="off"
              spellcheck="false"
              placeholder="orders-service-bus-connection"
            />
          </div>
          <div class="td-field">
            <label for="new-secret-value" class="td-label">Value</label>
            <div class="pw">
              <input
                id="new-secret-value"
                v-model="newValue"
                :type="showNew ? 'text' : 'password'"
                class="td-control td-control--sm"
                autocomplete="new-password"
                spellcheck="false"
              />
              <UiIconButton
                size="sm"
                variant="outline-secondary"
                :icon="showNew ? 'eye-off' : 'eye'"
                label="Show or hide the value"
                :aria-pressed="showNew"
                @click="showNew = !showNew"
              />
            </div>
          </div>
          <div class="secrets__add-submit">
            <UiButton
              type="submit"
              size="sm"
              variant="primary"
              :disabled="saving || !newName || !newValue"
              data-testid="add-secret"
            >
              <Icon name="plus" :size="14" />Save secret
            </UiButton>
          </div>
        </div>
        <div v-if="nameProblem" class="td-error" role="alert">{{ nameProblem }}</div>
      </form>

      <p v-if="overview.local.length === 0" class="secrets__empty td-small td-muted">
        No local secrets yet.
      </p>
      <div
        v-else
        class="secrets__table"
        tabindex="0"
        role="region"
        aria-label="Secrets (scrollable)"
      >
        <table class="td-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Value</th>
              <th>Used by</th>
              <th class="td-cell-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="secret in overview.local" :key="secret.name">
              <tr :data-testid="`secret-row-${secret.name}`">
                <td class="td-mono td-small">{{ secret.name }}</td>
                <td>
                  <UiBadge v-if="secret.source === 'missing'" variant="warning">Not set</UiBadge>
                  <UiBadge v-else-if="secret.source === 'environment'"
                    >Environment variable</UiBadge
                  >
                  <UiBadge v-else variant="success">Set</UiBadge>
                  <div v-if="secret.shadowedByEnvironment" class="td-small td-muted">
                    An environment variable overrides the file value.
                  </div>
                  <div v-if="secret.inFile" class="td-small td-muted">••••••••</div>
                </td>
                <td class="td-small">
                  <div v-for="use in secret.usedBy" :key="`${use.environmentId}/${use.target}`">
                    {{ use.environmentId }} / {{ use.target }}
                  </div>
                  <span v-if="secret.usedBy.length === 0" class="td-muted">Not referenced</span>
                </td>
                <td class="td-cell-actions">
                  <template v-if="removing === secret.name">
                    <UiButton
                      size="sm"
                      variant="danger"
                      data-testid="confirm-remove-secret"
                      @click="remove(secret.name)"
                      >Remove</UiButton
                    >
                    <UiButton size="sm" variant="outline-secondary" @click="removing = ''"
                      >Keep</UiButton
                    >
                  </template>
                  <template v-else>
                    <UiButton
                      size="sm"
                      variant="outline-primary"
                      :data-testid="`edit-secret-${secret.name}`"
                      @click="startEdit(secret.name)"
                    >
                      {{ secret.inFile ? 'Replace value' : 'Set value' }}
                    </UiButton>
                    <UiIconButton
                      v-if="secret.inFile"
                      size="sm"
                      variant="outline-danger"
                      icon="trash"
                      :label="`Remove ${secret.name}`"
                      @click="removing = secret.name"
                    />
                  </template>
                </td>
              </tr>
              <tr v-if="editing === secret.name" :data-testid="`edit-row-${secret.name}`">
                <td colspan="4" class="secrets__edit-cell">
                  <form class="secrets__edit" @submit.prevent="saveEdit(secret.name)">
                    <label :for="`edit-${secret.name}`" class="td-small"
                      >New value for <code>{{ secret.name }}</code></label
                    >
                    <div class="pw secrets__edit-input">
                      <input
                        :id="`edit-${secret.name}`"
                        v-model="editValue"
                        :type="showEdit ? 'text' : 'password'"
                        class="td-control td-control--sm"
                        autocomplete="new-password"
                        spellcheck="false"
                      />
                      <UiIconButton
                        size="sm"
                        variant="outline-secondary"
                        :icon="showEdit ? 'eye-off' : 'eye'"
                        label="Show or hide the value"
                        :aria-pressed="showEdit"
                        @click="showEdit = !showEdit"
                      />
                    </div>
                    <UiButton
                      type="submit"
                      size="sm"
                      variant="primary"
                      :disabled="saving || !editValue"
                      data-testid="save-edit"
                      >Save</UiButton
                    >
                    <UiButton size="sm" variant="outline-secondary" @click="cancelEdit"
                      >Cancel</UiButton
                    >
                  </form>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </UiCard>

    <UiCard flush data-testid="key-vault-references">
      <template #header>
        <div>
          <div class="secrets__title">Key Vault references</div>
          <div class="td-small td-muted">
            Testd stores only the reference. Values stay in Azure Key Vault and are fetched only
            when a Step runs, using <code>az login</code> or a workload identity. To add one, choose
            <em>Azure Key Vault</em> as the source of a target's credential in an
            <RouterLink to="/environments">Environment</RouterLink>.
          </div>
        </div>
      </template>
      <div class="secrets__vault td-small">
        Vault for bare secret names:
        <UiBadge
          :variant="overview.keyVaultConfigured ? 'success' : 'warning'"
          data-testid="vault-status"
        >
          {{ overview.keyVaultConfigured ? 'configured' : 'not configured' }}
        </UiBadge>
        <span v-if="!overview.keyVaultConfigured" class="td-muted">
          Set <code>TEST_PLATFORM_KEY_VAULT_URL</code> (or use full secret URIs) and restart.
        </span>
      </div>
      <p v-if="overview.keyVault.length === 0" class="secrets__empty td-small td-muted">
        No Environment uses a Key Vault reference yet.
      </p>
      <div
        v-else
        class="secrets__table"
        tabindex="0"
        role="region"
        aria-label="Secrets (scrollable)"
      >
        <table class="td-table">
          <thead>
            <tr>
              <th>Reference</th>
              <th>Used as</th>
              <th>Used by</th>
              <th>Vault</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="reference in overview.keyVault" :key="reference.name">
              <td class="td-mono td-small secrets__break">{{ reference.name }}</td>
              <td class="td-small">{{ reference.usage ?? 'default' }}</td>
              <td class="td-small">
                <div v-for="use in reference.usedBy" :key="`${use.environmentId}/${use.target}`">
                  {{ use.environmentId }} / {{ use.target }}
                </div>
              </td>
              <td>
                <UiBadge :variant="reference.status === 'configured' ? 'success' : 'warning'">
                  {{
                    reference.status === 'configured' ? 'Vault configured' : 'No vault configured'
                  }}
                </UiBadge>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import PageHeader from '~/components/PageHeader.vue'
import LoadingState from '~/components/platform/LoadingState.vue'
import ProblemAlert from '~/components/platform/ProblemAlert.vue'
import Icon from '~/components/ui/Icon.vue'
import UiAlert from '~/components/ui/UiAlert.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import { useSecretMutations, useSecretsOverview } from '~/api/queries'

const { data: overview, isPending, error, refetch } = useSecretsOverview()
const mutations = useSecretMutations()

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

const newName = ref('')
const newValue = ref('')
const showNew = ref(false)
const editing = ref('')
const editValue = ref('')
const showEdit = ref(false)
const removing = ref('')
const notice = ref('')

const saving = computed(() => mutations.set.isPending.value)
const actionError = computed(() => mutations.set.error.value ?? mutations.remove.error.value)
const nameProblem = computed(() =>
  newName.value && !NAME.test(newName.value)
    ? 'A name starts with a letter and has at most 64 letters, digits, "-" or "_".'
    : '',
)

const store = (name: string, value: string, done: () => void) => {
  mutations.set.mutate(
    { name, value },
    {
      onSuccess: (result) => {
        notice.value = result.shadowedByEnvironment
          ? `"${name}" was saved, but an environment variable of the same name overrides it.`
          : ''
        done()
      },
    },
  )
}

const add = () => {
  if (nameProblem.value) return
  store(newName.value, newValue.value, () => {
    newName.value = ''
    newValue.value = ''
    showNew.value = false
  })
}

const startEdit = (name: string) => {
  editing.value = name
  editValue.value = ''
  showEdit.value = false
}
const cancelEdit = () => {
  editing.value = ''
  editValue.value = ''
}
const saveEdit = (name: string) => store(name, editValue.value, cancelEdit)

const remove = (name: string) =>
  mutations.remove.mutate(name, { onSettled: () => (removing.value = '') })
</script>

<style scoped>
.secrets {
  display: flex;
  flex-direction: column;
  gap: var(--td-space-5);
}
.secrets__note {
  margin-bottom: var(--td-space-4);
}
.secrets__title {
  font-weight: 650;
}
.secrets__add {
  padding: var(--td-space-4);
  border-bottom: 1px solid var(--td-border);
}
.secrets__add-grid {
  display: grid;
  grid-template-columns: minmax(10rem, 4fr) minmax(12rem, 5fr) auto;
  align-items: end;
  gap: var(--td-space-3);
}
@media (max-width: 47.99rem) {
  .secrets__add-grid {
    grid-template-columns: 1fr;
  }
}
.pw {
  display: flex;
  gap: var(--td-space-1);
}
.pw .td-control {
  flex: 1 1 auto;
}
.secrets__empty {
  margin: 0;
  padding: var(--td-space-4);
}
.secrets__table {
  overflow-x: auto;
}
.secrets__edit-cell {
  background: var(--td-surface-2);
}
.secrets__edit {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--td-space-2);
}
.secrets__edit-input {
  flex: 1 1 14rem;
}
.secrets__vault {
  padding: var(--td-space-3) var(--td-space-4);
  border-bottom: 1px solid var(--td-border);
}
.secrets__break {
  overflow-wrap: anywhere;
}
</style>
