import { apiRequest, getApiBaseUrl, type ApiRequestOptions } from '~/api/client'
import type {
  Artifact,
  AssetSummary,
  AssetVersionRecord,
  EnvironmentConfig,
  EnvironmentConfigList,
  EnvironmentSummary,
  InspectedMessage,
  InspectorMessagePage,
  InspectorSummary,
  InspectorWatch,
  InspectorWatchInput,
  JsonValue,
  RunDetail,
  RunPauseInspection,
  RunSummary,
  SecretsOverview,
  StepRun,
  StepTypeMetadata,
  SuiteRunStatus,
  SuiteRunView,
  SuiteAsset,
  TestDataAsset,
  MockApiRequestPage,
  MockApiStatus,
  MockSetupAsset,
  TestDefinition,
  ValidationIssue,
} from '~/api/types'

const V1 = '/api/v1'

const query = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

/** Fields the author controls; the server assigns `id`, `metadata` and the version number. */
export type Draft<T> = Omit<T, 'id' | 'schemaVersion' | 'metadata' | 'version'> & {
  version?: number
}

export type AssetListParams = { search?: string; tag?: string }

const assetApi = <T extends { id: string; version: number }>(path: string) => ({
  list: (params: AssetListParams = {}, options?: ApiRequestOptions) =>
    apiRequest<{ items: AssetSummary[] }>(`${V1}/${path}${query(params)}`, options).then(
      (r) => r.items,
    ),
  get: (id: string, version?: number, options?: ApiRequestOptions) =>
    apiRequest<T>(`${V1}/${path}/${encodeURIComponent(id)}${query({ version })}`, options),
  versions: (id: string, options?: ApiRequestOptions) =>
    apiRequest<{ items: AssetVersionRecord[] }>(
      `${V1}/${path}/${encodeURIComponent(id)}/versions`,
      options,
    ).then((r) => r.items),
  create: (body: Draft<T>, options?: ApiRequestOptions) =>
    apiRequest<T>(`${V1}/${path}`, { ...options, method: 'POST', body }),
  update: (id: string, body: Draft<T> & { version: number }, options?: ApiRequestOptions) =>
    apiRequest<T>(`${V1}/${path}/${encodeURIComponent(id)}`, { ...options, method: 'PUT', body }),
  remove: (id: string) =>
    apiRequest<void>(`${V1}/${path}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
})

export const testsApi = assetApi<TestDefinition>('tests')
export const testDataApi = assetApi<TestDataAsset>('test-data')
export const suitesApi = assetApi<SuiteAsset>('suites')
export const mockSetupsApi = assetApi<MockSetupAsset>('mock-setups')

/** Where the SUT reaches the Mock API server (the worker serves it). */
export type MockApiInfo = { baseUrl: string; host: string; hostname: string; port: string }

export const mockApiLogApi = {
  status: (options?: ApiRequestOptions) =>
    apiRequest<MockApiStatus>(`${V1}/helpers/mock-api/status`, options),
  requests: (limit: number, options?: ApiRequestOptions) =>
    apiRequest<MockApiRequestPage>(`${V1}/helpers/mock-api/requests${query({ limit })}`, options),
  clear: () => apiRequest<void>(`${V1}/helpers/mock-api/requests`, { method: 'DELETE' }),
}

export const getMockApiInfo = (options?: ApiRequestOptions) =>
  apiRequest<MockApiInfo>(`${V1}/helpers/mock-api`, options)

/** What the server changed when it derived a position-managed Test's order and connections. */
export type NormalizationReport = {
  autoSequenceFromPosition: true
  edgesChanged: boolean
  orderChanged: boolean
  previousOrder: string[]
  order: string[]
  moves: string[]
}

export type ApiWarning = { code: string; message: string }

export type TestValidationReport = {
  valid: boolean
  issues: ValidationIssue[]
  order: string[]
  warnings?: ApiWarning[]
  normalization?: NormalizationReport
  normalized?: { editor: unknown; edges: { from: string; to: string }[] }
}

/** Codes from the `X-Platform-Warnings` header of a save response. */
export const warningCodes = (response: Response | undefined): string[] =>
  (response?.headers.get('X-Platform-Warnings') ?? '')
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean)

export const validateTestDraft = (
  id: string,
  draft: Draft<TestDefinition> | undefined,
  environmentId?: string,
) =>
  apiRequest<TestValidationReport>(`${V1}/tests/${encodeURIComponent(id)}/validate`, {
    method: 'POST',
    body: { ...(environmentId ? { environmentId } : {}), ...(draft ? { test: draft } : {}) },
  })

export const listStepTypes = (options?: ApiRequestOptions) =>
  apiRequest<{ items: StepTypeMetadata[] }>(`${V1}/step-types`, options).then((r) => r.items)

export type GlobalVariableInfo = {
  name: string
  scope: 'run' | 'test' | 'environment'
  type: 'text' | 'number'
  description: string
  example: string
}

export const listGlobalVariables = (options?: ApiRequestOptions) =>
  apiRequest<{ items: GlobalVariableInfo[] }>(`${V1}/globals`, options).then((r) => r.items)

export const listEnvironments = (options?: ApiRequestOptions) =>
  apiRequest<{ items: EnvironmentSummary[] }>(`${V1}/environments`, options).then((r) => r.items)

export type CreateRunInput = {
  testId: string
  testVersion?: number
  dataSetId: string
  dataSetVersion?: number
  environmentId: string
  variableOverrides?: Record<string, JsonValue>
}

export type RunListParams = {
  status?: string
  testId?: string
  environmentId?: string
  limit?: number
  offset?: number
}

export const runsApi = {
  create: (body: CreateRunInput) => apiRequest<RunSummary>(`${V1}/runs`, { method: 'POST', body }),
  list: (params: RunListParams = {}, options?: ApiRequestOptions) =>
    apiRequest<{ items: RunSummary[] }>(`${V1}/runs${query(params)}`, options).then((r) => r.items),
  get: (id: string, options?: ApiRequestOptions) =>
    apiRequest<RunDetail>(`${V1}/runs/${encodeURIComponent(id)}`, options),
  step: (id: string, stepRunId: string, options?: ApiRequestOptions) =>
    apiRequest<StepRun>(
      `${V1}/runs/${encodeURIComponent(id)}/steps/${encodeURIComponent(stepRunId)}`,
      options,
    ),
  cancel: (id: string) =>
    apiRequest<RunSummary>(`${V1}/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  rerun: (id: string) =>
    apiRequest<RunSummary>(`${V1}/runs/${encodeURIComponent(id)}/rerun`, { method: 'POST' }),
  eventsUrl: (id: string) => `${getApiBaseUrl()}${V1}/runs/${encodeURIComponent(id)}/events`,
  /** The active Breakpoint pause; a 404 problem when the Run is not paused. */
  pause: (id: string, options?: ApiRequestOptions) =>
    apiRequest<RunPauseInspection>(`${V1}/runs/${encodeURIComponent(id)}/pause`, options),
  /** `continuationGeneration` is the pause that was inspected; a stale one is a 409. */
  resume: (id: string, continuationGeneration: number) =>
    apiRequest<{
      run: RunSummary
      continuationGeneration: number
      alreadyResumed: boolean
    }>(`${V1}/runs/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
      body: { continuationGeneration },
    }),
}

export type CreateSuiteRunInput = {
  suiteId: string
  suiteVersion?: number
  environmentId: string
  maxConcurrency?: number
  variableOverrides?: Record<string, JsonValue>
}

export type SuiteRunListParams = { status?: SuiteRunStatus; limit?: number; offset?: number }
export type SuiteRunRow = Omit<SuiteRunView, 'items'>

export const suiteRunsApi = {
  create: (body: CreateSuiteRunInput) =>
    apiRequest<SuiteRunView>(`${V1}/suite-runs`, { method: 'POST', body }),
  list: (params: SuiteRunListParams = {}, options?: ApiRequestOptions) =>
    apiRequest<{ items: SuiteRunRow[] }>(`${V1}/suite-runs${query(params)}`, options).then(
      (r) => r.items,
    ),
  get: (id: string, options?: ApiRequestOptions) =>
    apiRequest<SuiteRunView>(`${V1}/suite-runs/${encodeURIComponent(id)}`, options),
  cancel: (id: string) =>
    apiRequest<SuiteRunView>(`${V1}/suite-runs/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    }),
  rerun: (id: string) =>
    apiRequest<SuiteRunView>(`${V1}/suite-runs/${encodeURIComponent(id)}/rerun`, {
      method: 'POST',
    }),
  eventsUrl: (id: string) => `${getApiBaseUrl()}${V1}/suite-runs/${encodeURIComponent(id)}/events`,
}

export const artifactApi = {
  metadata: (id: string, options?: ApiRequestOptions) =>
    apiRequest<Artifact>(`${V1}/artifacts/${encodeURIComponent(id)}/metadata`, options),
  /** Plain link to the stored bytes; the API forces risky types to download. */
  contentUrl: (id: string) => `${getApiBaseUrl()}${V1}/artifacts/${encodeURIComponent(id)}`,
}

export const inspectorApi = {
  summary: (options?: ApiRequestOptions) =>
    apiRequest<InspectorSummary>(`${V1}/inspector`, options),
  addWatch: (body: InspectorWatchInput) =>
    apiRequest<InspectorWatch>(`${V1}/inspector/watches`, { method: 'POST', body }),
  removeWatch: (id: string) =>
    apiRequest<void>(`${V1}/inspector/watches/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  messages: (params: { limit?: number; before?: number } = {}, options?: ApiRequestOptions) => {
    const query = new URLSearchParams()
    if (params.limit) query.set('limit', String(params.limit))
    if (params.before) query.set('before', String(params.before))
    const text = query.toString()
    return apiRequest<InspectorMessagePage>(
      `${V1}/inspector/messages${text ? `?${text}` : ''}`,
      options,
    )
  },
  message: (id: string, options?: ApiRequestOptions) =>
    apiRequest<InspectedMessage>(`${V1}/inspector/messages/${encodeURIComponent(id)}`, options),
  clear: () => apiRequest<{ cleared: number }>(`${V1}/inspector/clear`, { method: 'POST' }),
  viewed: (upToSeq: number) =>
    apiRequest<void>(`${V1}/inspector/viewed`, { method: 'POST', body: { upToSeq } }),
}

export const environmentConfigsApi = {
  list: (options?: ApiRequestOptions) =>
    apiRequest<EnvironmentConfigList>(`${V1}/environment-configs`, options),
  create: (environment: EnvironmentConfig, revision: string) =>
    apiRequest<EnvironmentConfigList>(`${V1}/environment-configs`, {
      method: 'POST',
      body: { environment, revision },
    }),
  update: (environment: EnvironmentConfig, revision: string) =>
    apiRequest<EnvironmentConfigList>(
      `${V1}/environment-configs/${encodeURIComponent(environment.id)}`,
      { method: 'PUT', body: { environment, revision } },
    ),
  remove: (id: string, revision: string) =>
    apiRequest<EnvironmentConfigList>(
      `${V1}/environment-configs/${encodeURIComponent(id)}?revision=${encodeURIComponent(revision)}`,
      { method: 'DELETE' },
    ),
}

/** Secret values are write-only: there is no call that reads one back. */
export const secretsApi = {
  overview: (options?: ApiRequestOptions) => apiRequest<SecretsOverview>(`${V1}/secrets`, options),
  setLocal: (name: string, value: string) =>
    apiRequest<{ shadowedByEnvironment: boolean }>(
      `${V1}/secrets/local/${encodeURIComponent(name)}`,
      { method: 'PUT', body: { value } },
    ),
  removeLocal: (name: string) =>
    apiRequest<void>(`${V1}/secrets/local/${encodeURIComponent(name)}`, { method: 'DELETE' }),
}
