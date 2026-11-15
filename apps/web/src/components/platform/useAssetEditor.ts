import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRouter } from 'vue-router'
import { useQueryClient } from '@tanstack/vue-query'
import { problemIssues } from '~/api/client'
import { mockSetupsApi, suitesApi, testDataApi } from '~/api/platform'
import { keys, useAsset } from '~/api/queries'
import type { ValidationIssue } from '~/api/types'

type Kind = 'testData' | 'suites' | 'mockSetups'
type Stored = { id: string; version: number }

export type AssetEditorOptions<A extends Stored> = {
  kind: Kind
  basePath: string
  id: Ref<string | undefined>
  /** Copies a loaded asset into the form state. */
  apply: (asset: A) => void
  /** Resets the form state for a new asset. */
  reset: () => void
  /** The request body for the current form state. */
  body: () => Record<string, unknown>
}

/**
 * Load/save/dirty handling shared by the Test Data and Suite forms: optimistic-version updates,
 * RFC 7807 errors with field issues, and a warning before unsaved changes are lost.
 */
export const useAssetEditor = <A extends Stored>(options: AssetEditorOptions<A>) => {
  const router = useRouter()
  const client = useQueryClient()
  const api = ({ testData: testDataApi, suites: suitesApi, mockSetups: mockSetupsApi }[
    options.kind
  ] ?? suitesApi) as unknown as {
    create: (body: Record<string, unknown>) => Promise<A>
    update: (id: string, body: Record<string, unknown>) => Promise<A>
  }

  const query = useAsset(options.kind, options.id)
  const version = ref<number>()
  const baseline = ref('')
  const saving = ref(false)
  const saveError = ref<unknown>()
  const issues = ref<ValidationIssue[]>([])

  const snapshot = () => JSON.stringify(options.body())
  const dirty = computed(() => baseline.value !== '' && snapshot() !== baseline.value)

  const settle = () => {
    baseline.value = snapshot()
  }

  const initNew = () => {
    options.reset()
    version.value = undefined
    settle()
  }
  if (!options.id.value) initNew()

  let loadedId: string | undefined
  watch(
    query.data,
    (asset) => {
      if (!asset) return
      const stored = asset as unknown as A
      const switched = stored.id !== loadedId
      const newer = stored.version !== version.value && !dirty.value
      if (!switched && !newer) return
      options.apply(stored)
      loadedId = stored.id
      version.value = stored.version
      settle()
    },
    { immediate: true },
  )

  const save = async (): Promise<A | undefined> => {
    saving.value = true
    saveError.value = undefined
    issues.value = []
    try {
      const body = options.body()
      const id = options.id.value
      const asset =
        id && version.value !== undefined
          ? await api.update(id, { ...body, version: version.value })
          : await api.create(body)
      loadedId = asset.id
      version.value = asset.version
      settle()
      await client.invalidateQueries({ queryKey: keys[options.kind] })
      if (!id) await router.replace(`${options.basePath}/${asset.id}`)
      return asset
    } catch (error) {
      saveError.value = error
      issues.value = problemIssues(error)
      return undefined
    } finally {
      saving.value = false
    }
  }

  const confirmLeave = () =>
    !dirty.value || window.confirm('You have unsaved changes. Leave without saving?')
  onBeforeRouteLeave(confirmLeave)
  onBeforeRouteUpdate(confirmLeave)
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (dirty.value) event.preventDefault()
  }
  window.addEventListener('beforeunload', beforeUnload)
  onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))

  return {
    loading: computed(() => Boolean(options.id.value) && query.isPending.value),
    loadError: query.error,
    refetch: query.refetch,
    version,
    dirty,
    saving,
    saveError,
    issues,
    save,
  }
}
