import { computed, type MaybeRefOrGetter, toValue } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import {
  environmentConfigsApi,
  listEnvironments,
  getMockApiInfo,
  listGlobalVariables,
  mockApiLogApi,
  mockSetupsApi,
  inspectorApi,
  listStepTypes,
  runsApi,
  secretsApi,
  suiteRunsApi,
  suitesApi,
  testDataApi,
  testsApi,
  type AssetListParams,
  type CreateRunInput,
  type CreateSuiteRunInput,
  type RunListParams,
  type SuiteRunListParams,
} from '~/api/platform'
import {
  isActiveRunStatus,
  isActiveSuiteRunStatus,
  type MockSetupAsset,
  type SuiteAsset,
  type TestDataAsset,
  type TestDefinition,
} from '~/api/types'

/** Query keys are centralised so mutations invalidate exactly what they change. */
export const keys = {
  tests: ['tests'] as const,
  testData: ['test-data'] as const,
  suites: ['suites'] as const,
  mockSetups: ['mock-setups'] as const,
  mockApi: ['mock-api'] as const,
  runs: ['runs'] as const,
  suiteRuns: ['suite-runs'] as const,
  catalog: ['catalog'] as const,
  inspector: ['inspector'] as const,
  environmentConfigs: ['environment-configs'] as const,
  secrets: ['secrets'] as const,
}

const apis = {
  tests: testsApi,
  testData: testDataApi,
  suites: suitesApi,
  mockSetups: mockSetupsApi,
}
type AssetKind = keyof typeof apis
type AssetOfKind = {
  tests: TestDefinition
  testData: TestDataAsset
  suites: SuiteAsset
  mockSetups: MockSetupAsset
}

export const useAssetList = (kind: AssetKind, params: MaybeRefOrGetter<AssetListParams> = {}) =>
  useQuery({
    queryKey: computed(() => [...keys[kind], 'list', toValue(params)]),
    queryFn: ({ signal }) => apis[kind].list(toValue(params), { signal }),
  })

export const useAsset = <K extends AssetKind>(
  kind: K,
  id: MaybeRefOrGetter<string | undefined>,
  version?: MaybeRefOrGetter<number | undefined>,
) =>
  useQuery({
    queryKey: computed(() => [...keys[kind], 'detail', toValue(id), toValue(version)]),
    queryFn: ({ signal }) =>
      (apis[kind].get as (id: string, version?: number, o?: object) => Promise<AssetOfKind[K]>)(
        toValue(id) as string,
        toValue(version),
        { signal },
      ),
    enabled: computed(() => Boolean(toValue(id))),
  })

export const useAssetVersions = (kind: AssetKind, id: MaybeRefOrGetter<string | undefined>) =>
  useQuery({
    queryKey: computed(() => [...keys[kind], 'versions', toValue(id)]),
    queryFn: ({ signal }) => apis[kind].versions(toValue(id) as string, { signal }),
    enabled: computed(() => Boolean(toValue(id))),
  })

export const useDeleteAsset = (kind: Exclude<AssetKind, 'suites'>) => {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apis[kind].remove(id),
    onSuccess: () => client.invalidateQueries({ queryKey: keys[kind] }),
  })
}

export const useStepTypes = () =>
  useQuery({
    queryKey: [...keys.catalog, 'step-types'],
    queryFn: ({ signal }) => listStepTypes({ signal }),
    staleTime: 5 * 60_000,
  })

/** Whether the worker is serving the Mock API server; polled slowly, faster while the panel is open. */
export const useMockApiStatus = (intervalMs: MaybeRefOrGetter<number> = 5000) =>
  useQuery({
    queryKey: [...keys.mockApi, 'status'],
    queryFn: ({ signal }) => mockApiLogApi.status({ signal }),
    refetchInterval: () => toValue(intervalMs),
    refetchIntervalInBackground: false,
  })

export const useMockApiRequests = (
  limit: MaybeRefOrGetter<number>,
  enabled: MaybeRefOrGetter<boolean>,
) =>
  useQuery({
    queryKey: computed(() => [...keys.mockApi, 'requests', toValue(limit)]),
    queryFn: ({ signal }) => mockApiLogApi.requests(toValue(limit), { signal }),
    enabled: computed(() => toValue(enabled)),
    refetchInterval: 2000,
    refetchIntervalInBackground: false,
  })

export const useClearMockApiRequests = () => {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => mockApiLogApi.clear(),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.mockApi }),
  })
}

export const useMockApiInfo = () =>
  useQuery({
    queryKey: [...keys.catalog, 'mock-api'],
    queryFn: ({ signal }) => getMockApiInfo({ signal }),
    staleTime: 5 * 60_000,
  })

export const useGlobalVariables = () =>
  useQuery({
    queryKey: [...keys.catalog, 'globals'],
    queryFn: ({ signal }) => listGlobalVariables({ signal }),
    staleTime: 5 * 60_000,
  })

export const useEnvironments = () =>
  useQuery({
    queryKey: [...keys.catalog, 'environments'],
    queryFn: ({ signal }) => listEnvironments({ signal }),
    staleTime: 60_000,
  })

export const useRunList = (params: MaybeRefOrGetter<RunListParams>) =>
  useQuery({
    queryKey: computed(() => [...keys.runs, 'list', toValue(params)]),
    queryFn: ({ signal }) => runsApi.list(toValue(params), { signal }),
    // Keep the history fresh while anything on screen can still change.
    refetchInterval: (query) =>
      query.state.data?.some((run) => isActiveRunStatus(run.status)) ? 3000 : false,
  })

export const useRun = (id: MaybeRefOrGetter<string>, pollMs: MaybeRefOrGetter<number | false>) =>
  useQuery({
    queryKey: computed(() => [...keys.runs, 'detail', toValue(id)]),
    queryFn: ({ signal }) => runsApi.get(toValue(id), { signal }),
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status && !isActiveRunStatus(status) ? false : toValue(pollMs)
    },
  })

export const useCreateRun = () => {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateRunInput) => runsApi.create(input),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.runs }),
  })
}

export const useRunAction = (action: 'cancel' | 'rerun') => {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => runsApi[action](id),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.runs }),
  })
}

/** The active Breakpoint pause. Disabled unless the Run is paused, so a 404 is never polled. */
export const usePause = (
  id: MaybeRefOrGetter<string>,
  enabled: MaybeRefOrGetter<boolean>,
  generationHint?: MaybeRefOrGetter<number | undefined>,
) =>
  useQuery({
    queryKey: computed(() => [...keys.runs, 'pause', toValue(id), toValue(generationHint)]),
    queryFn: ({ signal }) => runsApi.pause(toValue(id), { signal }),
    enabled: computed(() => toValue(enabled)),
    retry: false,
  })

/** Resume sends the inspected generation; success or conflict both end with a full refresh. */
export const useResumeRun = () => {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; continuationGeneration: number }) =>
      runsApi.resume(input.id, input.continuationGeneration),
    onSettled: () => client.invalidateQueries({ queryKey: keys.runs }),
  })
}

export const useSuiteRunList = (params: MaybeRefOrGetter<SuiteRunListParams> = {}) =>
  useQuery({
    queryKey: computed(() => [...keys.suiteRuns, 'list', toValue(params)]),
    queryFn: ({ signal }) => suiteRunsApi.list(toValue(params), { signal }),
    refetchInterval: (query) =>
      query.state.data?.some((run) => isActiveSuiteRunStatus(run.status)) ? 3000 : false,
  })

export const useSuiteRun = (
  id: MaybeRefOrGetter<string>,
  pollMs: MaybeRefOrGetter<number | false>,
) =>
  useQuery({
    queryKey: computed(() => [...keys.suiteRuns, 'detail', toValue(id)]),
    queryFn: ({ signal }) => suiteRunsApi.get(toValue(id), { signal }),
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status && !isActiveSuiteRunStatus(status) ? false : toValue(pollMs)
    },
  })

export const useCreateSuiteRun = () => {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateSuiteRunInput) => suiteRunsApi.create(input),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.suiteRuns }),
  })
}

export const useSuiteRunAction = (action: 'cancel' | 'rerun') => {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => suiteRunsApi[action](id),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.suiteRuns }),
  })
}

/** Polled so the top-bar badge stays current; the panel polls faster while it is open. */
export const useInspectorSummary = (intervalMs: MaybeRefOrGetter<number> = 4000) =>
  useQuery({
    queryKey: [...keys.inspector, 'summary'],
    queryFn: ({ signal }) => inspectorApi.summary({ signal }),
    refetchInterval: () => toValue(intervalMs),
    refetchIntervalInBackground: false,
  })

export const useInspectorMessages = (
  limit: MaybeRefOrGetter<number>,
  enabled: MaybeRefOrGetter<boolean>,
) =>
  useQuery({
    queryKey: computed(() => [...keys.inspector, 'messages', toValue(limit)]),
    queryFn: ({ signal }) => inspectorApi.messages({ limit: toValue(limit) }, { signal }),
    enabled: computed(() => toValue(enabled)),
    refetchInterval: 2500,
  })

export const useInspectorMessage = (id: MaybeRefOrGetter<string | undefined>) =>
  useQuery({
    queryKey: computed(() => [...keys.inspector, 'message', toValue(id)]),
    queryFn: ({ signal }) => inspectorApi.message(toValue(id) as string, { signal }),
    enabled: computed(() => Boolean(toValue(id))),
    // A stored message never changes.
    staleTime: Infinity,
  })

export const useInspectorMutations = () => {
  const client = useQueryClient()
  const refresh = () => client.invalidateQueries({ queryKey: keys.inspector })
  return {
    addWatch: useMutation({ mutationFn: inspectorApi.addWatch, onSuccess: refresh }),
    removeWatch: useMutation({ mutationFn: inspectorApi.removeWatch, onSuccess: refresh }),
    clear: useMutation({ mutationFn: inspectorApi.clear, onSuccess: refresh }),
    markViewed: useMutation({ mutationFn: inspectorApi.viewed, onSuccess: refresh }),
  }
}

export const useEnvironmentConfigs = () =>
  useQuery({
    queryKey: keys.environmentConfigs,
    queryFn: ({ signal }) => environmentConfigsApi.list({ signal }),
  })

/** Saving or deleting an Environment changes the pickers, the secret usage, and the file revision. */
export const useEnvironmentConfigMutations = () => {
  const client = useQueryClient()
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: keys.environmentConfigs }),
      client.invalidateQueries({ queryKey: keys.catalog }),
      client.invalidateQueries({ queryKey: keys.secrets }),
    ])
  return {
    create: useMutation({
      mutationFn: (input: {
        environment: Parameters<typeof environmentConfigsApi.create>[0]
        revision: string
      }) => environmentConfigsApi.create(input.environment, input.revision),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: (input: {
        environment: Parameters<typeof environmentConfigsApi.update>[0]
        revision: string
      }) => environmentConfigsApi.update(input.environment, input.revision),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (input: { id: string; revision: string }) =>
        environmentConfigsApi.remove(input.id, input.revision),
      onSuccess: refresh,
    }),
  }
}

export const useSecretsOverview = () =>
  useQuery({
    queryKey: keys.secrets,
    queryFn: ({ signal }) => secretsApi.overview({ signal }),
  })

export const useSecretMutations = () => {
  const client = useQueryClient()
  const refresh = () => client.invalidateQueries({ queryKey: keys.secrets })
  return {
    set: useMutation({
      mutationFn: (input: { name: string; value: string }) =>
        secretsApi.setLocal(input.name, input.value),
      onSuccess: refresh,
    }),
    remove: useMutation({ mutationFn: secretsApi.removeLocal, onSuccess: refresh }),
  }
}
