// Types only: the browser shares the API contracts at compile time and never bundles them.
export type {
  Artifact,
  AzureBlobTarget,
  AzureServiceBusTarget,
  EnvironmentConfig,
  EnvironmentConfigList,
  EnvironmentTarget,
  HttpTarget,
  KeyVaultReferenceView,
  LocalSecretView,
  SecretReference,
  SecretUse,
  SecretUsage,
  SecretsOverview,
  TargetKind,
  ArtifactReference,
  EnvironmentSummary,
  ErrorInfo,
  JsonObject,
  InspectedMessage,
  InspectedMessageSummary,
  InspectorMessagePage,
  InspectorSummary,
  InspectorWatch,
  InspectorWatchInput,
  JsonSchema,
  JsonValue,
  PausedStepSummary,
  RunDetail,
  RunEvent,
  RunKind,
  RunPause,
  RunPauseInspection,
  RunStatus,
  RunSummary,
  StepLogEntry,
  StepRun,
  StepRunStatus,
  StepTypeMetadata,
  SuiteAsset,
  SuiteItem,
  SuiteRunCounts,
  SuiteRunItemStatus,
  SuiteRunItemView,
  SuiteRunStatus,
  SuiteRunUpdatedEvent,
  SuiteRunView,
  TestDataAsset,
  Helpers,
  MockApiRequestPage,
  MockApiRequestRecord,
  MockApiStatus,
  MockRule,
  MockRuleMethod,
  MockSetupAsset,
  TestDefinition,
  TestEdge,
  TestEditorSettings,
  TestNode,
  ValidationIssue,
} from '@test-platform/contracts'

/** Row returned by the asset list endpoints. */
export type AssetSummary = {
  id: string
  type: 'test' | 'test-data' | 'suite'
  name: string
  tags: string[]
  currentVersion: number
  contentHash: string
  updatedAt: string
}

export type AssetVersionRecord = {
  version: number
  contentHash: string
  createdAt: string
  createdBy: string
}

export const RUN_STATUS_VALUES = [
  'Queued',
  'Running',
  'Paused',
  'Cancelling',
  'Succeeded',
  'Failed',
  'Cancelled',
] as const

/** A Paused Run is still active: it waits for Resume or Cancel and must keep being refreshed. */
export const ACTIVE_RUN_STATUSES: readonly string[] = ['Queued', 'Running', 'Paused', 'Cancelling']
export const isActiveRunStatus = (status: string): boolean => ACTIVE_RUN_STATUSES.includes(status)

export const ACTIVE_SUITE_RUN_STATUSES: readonly string[] = [
  'Queued',
  'Running',
  'WaitingForBreakpoint',
  'Cancelling',
]
export const isActiveSuiteRunStatus = (status: string): boolean =>
  ACTIVE_SUITE_RUN_STATUSES.includes(status)

export const SUITE_RUN_STATUS_VALUES = [
  'Queued',
  'Running',
  'WaitingForBreakpoint',
  'Cancelling',
  'Succeeded',
  'Failed',
  'Cancelled',
] as const
