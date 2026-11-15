<template>
  <UiCard flush data-testid="asset-library">
    <template #header>
      <div class="lib__bar">
        <div class="lib__search">
          <label :for="`${kind}-search`" class="td-sr-only">Search {{ title }}</label>
          <input
            :id="`${kind}-search`"
            v-model="search"
            class="td-control"
            type="search"
            :placeholder="`Search ${title.toLowerCase()}…`"
          />
        </div>
        <UiButton :to="`${basePath}/new`" variant="primary" data-testid="new-asset">
          <Icon name="plus" :size="16" /> {{ newLabel }}
        </UiButton>
      </div>
    </template>

    <div class="lib__notices">
      <ProblemAlert :error="error" retryable @retry="() => refetch()" />
      <ProblemAlert :error="actionError" />
    </div>

    <LoadingState v-if="isPending" :label="`Loading ${title.toLowerCase()}…`" />

    <EmptyState
      v-else-if="!isError && items.length === 0"
      :title="
        search ? `No ${title.toLowerCase()} match “${search}”` : `No ${title.toLowerCase()} yet`
      "
      :description="search ? 'Try a different search.' : emptyHint"
    />

    <div
      v-else-if="items.length > 0"
      class="lib__table"
      tabindex="0"
      role="region"
      aria-label="Library (scrollable)"
    >
      <table class="td-table">
        <caption class="td-sr-only">
          {{
            title
          }}
        </caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Tags</th>
            <th scope="col">Version</th>
            <th scope="col">Updated</th>
            <th scope="col" class="lib__actions-head">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in items" :key="item.id" data-testid="asset-row">
            <td>
              <RouterLink :to="`${basePath}/${item.id}`" class="lib__name">{{
                item.name
              }}</RouterLink>
            </td>
            <td>
              <span class="lib__tags">
                <UiBadge v-for="tag in item.tags" :key="tag">{{ tag }}</UiBadge>
              </span>
            </td>
            <td class="td-mono">v{{ item.currentVersion }}</td>
            <td class="td-muted">{{ formatDate(item.updatedAt) }}</td>
            <td class="lib__actions">
              <UiButton
                v-if="runnable"
                :to="{ path: '/runs/new', query: { testId: item.id } }"
                size="sm"
                variant="outline-success"
                :aria-label="`Run ${item.name}`"
                >Run</UiButton
              >
              <UiButton
                :to="`${basePath}/${item.id}`"
                size="sm"
                variant="outline-primary"
                :aria-label="`Edit ${item.name}`"
                >Edit</UiButton
              >
              <UiButton
                size="sm"
                variant="outline-secondary"
                :disabled="busyId === item.id"
                :aria-label="`Clone ${item.name}`"
                @click="clone(item)"
                >Clone</UiButton
              >
              <UiButton
                v-if="deletable"
                size="sm"
                variant="outline-danger"
                :disabled="busyId === item.id"
                :aria-label="`Delete ${item.name}`"
                @click="remove(item)"
                >Delete</UiButton
              >
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </UiCard>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { refDebounced } from '@vueuse/core'
import { useQueryClient } from '@tanstack/vue-query'
import type { AssetSummary } from '~/api/types'
import { mockSetupsApi, suitesApi, testDataApi, testsApi } from '~/api/platform'
import { keys, useAssetList, useDeleteAsset } from '~/api/queries'
import EmptyState from '~/components/platform/EmptyState.vue'
import LoadingState from '~/components/platform/LoadingState.vue'
import ProblemAlert from '~/components/platform/ProblemAlert.vue'
import Icon from '~/components/ui/Icon.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiCard from '~/components/ui/UiCard.vue'

const props = defineProps<{
  kind: 'tests' | 'testData' | 'suites' | 'mockSetups'
  title: string
  basePath: string
  newLabel: string
  emptyHint: string
  runnable?: boolean
  deletable?: boolean
}>()

const router = useRouter()
const client = useQueryClient()
const search = ref('')
const debounced = refDebounced(search, 250)
const params = computed(() => ({ search: debounced.value.trim() || undefined }))

const { data, error, isPending, isError, refetch } = useAssetList(props.kind, params)
const items = computed(() => data.value ?? [])

const apis = {
  tests: testsApi,
  testData: testDataApi,
  suites: suitesApi,
  mockSetups: mockSetupsApi,
}
const busyId = ref<string>()
const actionError = ref<unknown>()
const deleteMutation = props.kind === 'suites' ? undefined : useDeleteAsset(props.kind)

const formatDate = (iso: string) => new Date(iso).toLocaleString()

const clone = async (item: AssetSummary) => {
  busyId.value = item.id
  actionError.value = undefined
  try {
    const api = apis[props.kind] as unknown as {
      get: (id: string) => Promise<Record<string, unknown>>
      create: (body: Record<string, unknown>) => Promise<{ id: string }>
    }
    const source = await api.get(item.id)
    const body: Record<string, unknown> = { ...source, name: `Copy of ${item.name}`.slice(0, 200) }
    for (const key of ['id', 'version', 'metadata', 'schemaVersion']) delete body[key]
    const created = await api.create(body)
    await client.invalidateQueries({ queryKey: keys[props.kind] })
    await router.push(`${props.basePath}/${created.id}`)
  } catch (err) {
    actionError.value = err
  } finally {
    busyId.value = undefined
  }
}

const remove = async (item: AssetSummary) => {
  if (!deleteMutation || !window.confirm(`Delete “${item.name}”? This cannot be undone.`)) return
  busyId.value = item.id
  actionError.value = undefined
  try {
    await deleteMutation.mutateAsync(item.id)
  } catch (err) {
    actionError.value = err
  } finally {
    busyId.value = undefined
  }
}
</script>

<style scoped>
.lib__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--td-space-3);
  width: 100%;
}
.lib__search {
  flex: 1 1 14rem;
  max-width: 24rem;
}
.lib__notices:not(:empty) {
  padding: var(--td-space-4) var(--td-space-4) 0;
}
.lib__table {
  overflow-x: auto;
}
.lib__name {
  font-weight: 650;
}
.lib__tags {
  display: inline-flex;
  flex-wrap: wrap;
  gap: var(--td-space-1);
}
.lib__actions-head,
.lib__actions {
  text-align: right !important;
  white-space: nowrap;
}
.lib__actions {
  display: table-cell;
}
.lib__actions > * + * {
  margin-left: var(--td-space-1);
}
</style>
