<template>
  <PageHeader title="Environments" subtitle="Configuration" />

  <p class="td-page-note">
    An Environment names the systems a Run may call: hosts, what is allowed on each, limits, and
    <em>references</em> to secrets. Tests refer to targets by name only. Secret values are managed
    on the <RouterLink to="/secrets">Secrets</RouterLink> page.
  </p>

  <ProblemAlert :error="error" retryable @retry="() => refetch()" />
  <ProblemAlert :error="actionError" />

  <UiCard flush data-testid="environment-list">
    <template #header>
      <div class="envs__bar">
        <span class="envs__count"
          >{{ items.length }} Environment{{ items.length === 1 ? '' : 's' }}</span
        >
        <UiButton to="/environments/new" variant="primary" size="sm" data-testid="new-environment">
          <Icon name="plus" :size="16" />New Environment
        </UiButton>
      </div>
    </template>
    <LoadingState v-if="isPending" label="Loading Environments" />
    <EmptyState
      v-else-if="!error && items.length === 0"
      title="No Environments yet"
      description="Create one to choose it when running a Test."
    />
    <div
      v-else-if="items.length > 0"
      class="envs__table"
      tabindex="0"
      role="region"
      aria-label="Environments (scrollable)"
    >
      <table class="td-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Id</th>
            <th>Classification</th>
            <th>Targets</th>
            <th class="td-cell-actions">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="environment in items"
            :key="environment.id"
            :data-testid="`environment-row-${environment.id}`"
          >
            <td class="envs__name">{{ environment.name }}</td>
            <td class="td-mono td-small">{{ environment.id }}</td>
            <td>
              <UiBadge :variant="classificationVariant(environment.classification)">{{
                environment.classification
              }}</UiBadge>
            </td>
            <td class="td-small">
              <div v-for="(target, name) in environment.targets" :key="name" class="td-truncate">
                <span class="envs__name">{{ name }}</span>
                <span class="td-muted">
                  · {{ kindLabel(target.kind) }} · {{ targetSummary(target) }}</span
                >
              </div>
              <span v-if="Object.keys(environment.targets).length === 0" class="td-muted"
                >None</span
              >
            </td>
            <td class="td-cell-actions">
              <template v-if="confirming === environment.id">
                <UiButton
                  size="sm"
                  variant="danger"
                  :disabled="removing"
                  data-testid="confirm-delete"
                  @click="remove(environment.id)"
                >
                  Delete
                </UiButton>
                <UiButton size="sm" variant="outline-secondary" @click="confirming = ''"
                  >Keep</UiButton
                >
              </template>
              <template v-else>
                <UiButton
                  :to="`/environments/${environment.id}`"
                  size="sm"
                  variant="outline-primary"
                >
                  <Icon name="pencil" :size="14" />Edit
                </UiButton>
                <UiIconButton
                  size="sm"
                  variant="outline-danger"
                  icon="trash"
                  :label="`Delete ${environment.name}`"
                  @click="confirming = environment.id"
                />
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <template v-if="items.length > 0" #footer>
      <span class="td-small td-muted">
        Runs that already started keep their own copy of the Environment, so deleting one never
        changes them.
      </span>
    </template>
  </UiCard>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import PageHeader from '~/components/PageHeader.vue'
import EmptyState from '~/components/platform/EmptyState.vue'
import LoadingState from '~/components/platform/LoadingState.vue'
import ProblemAlert from '~/components/platform/ProblemAlert.vue'
import Icon from '~/components/ui/Icon.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import { useEnvironmentConfigMutations, useEnvironmentConfigs } from '~/api/queries'
import { TARGET_KINDS, targetSummary } from '~/components/platform/environment-form'

const { data, isPending, error, refetch } = useEnvironmentConfigs()
const mutations = useEnvironmentConfigMutations()

const items = computed(() => data.value?.items ?? [])
const confirming = ref('')
const removing = computed(() => mutations.remove.isPending.value)
const actionError = computed(() => mutations.remove.error.value)

const kindLabel = (kind: string) => TARGET_KINDS.find((item) => item.value === kind)?.label ?? kind
const classificationVariant = (classification: string) =>
  ({ LOCAL: 'neutral', TEST: 'info', STAGING: 'warning', PRODUCTION: 'danger' })[classification] as
    | 'neutral'
    | 'info'
    | 'warning'
    | 'danger'

const remove = (id: string) => {
  if (!data.value) return
  mutations.remove.mutate(
    { id, revision: data.value.revision },
    { onSettled: () => (confirming.value = '') },
  )
}
</script>

<style scoped>
.envs__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--td-space-3);
  width: 100%;
}
.envs__count,
.envs__name {
  font-weight: 650;
}
.envs__table {
  overflow-x: auto;
}
</style>
