import type { MockSetupAsset, SuiteAsset, TestDataAsset, TestDefinition } from './assets.js';
import type { EnvironmentConfig, EnvironmentSummary } from './environment.js';
import type { ErrorInfo } from './errors.js';
import type { JsonValue } from './json.js';

export const RUN_KINDS = ['test', 'suite'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const RUN_STATUSES = [
  'Queued',
  'Running',
  'Paused',
  'Cancelling',
  'Succeeded',
  'Failed',
  'Cancelled',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const STEP_RUN_STATUSES = [
  'Queued',
  'Running',
  'Paused',
  'Succeeded',
  'Failed',
  'Retrying',
  'Skipped',
  'Cancelled',
] as const;
export type StepRunStatus = (typeof STEP_RUN_STATUSES)[number];

export type AssetRef = { id: string; version: number };

/** Immutable copies captured at Run creation so reruns never see edited definitions. */
export type RunSnapshots = {
  test?: TestDefinition;
  testData?: TestDataAsset;
  suite?: SuiteAsset;
  environment: EnvironmentConfig;
  /** The Mock API setups this Run serves, frozen with the Run (Test and Suite level together). */
  mockSetups?: MockSetupAsset[];
};

export type Run = {
  id: string;
  kind: RunKind;
  status: RunStatus;
  environmentId: string;
  requestedBy: string;
  requestedAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelRequestedAt?: string;
  /** When the Run last paused at a Breakpoint; cleared on resume. */
  pausedAt?: string;
  /**
   * Increments each time a paused Run is resumed. Absent means 0 (never resumed), so Runs
   * created before Phase 2 are unchanged.
   */
  continuationGeneration?: number;
  parentRunId?: string;
  rerunOfRunId?: string;
  /** 1 for a Test's first Run, then 2, 3 …; set when the Run is stored. Absent for Suite Runs. */
  runNumber?: number;
  test?: AssetRef;
  testData?: AssetRef;
  suite?: AssetRef;
  variableOverrides: Record<string, JsonValue>;
  snapshots: RunSnapshots;
  error?: ErrorInfo;
};

/** A Run without its (potentially large) snapshots, for lists. */
export type RunSummary = Omit<Run, 'snapshots'>;

/** API representation of a Run: snapshots included, Environment reduced to its non-secret summary. */
export type RunDetail = RunSummary & {
  snapshots: Omit<RunSnapshots, 'environment'> & { environment: EnvironmentSummary };
  stepRuns: StepRun[];
  /**
   * Highest event sequence number that existed when this detail was read. A client that
   * reconnects fetches the detail, then opens the event stream with this as `Last-Event-ID`.
   */
  lastEventSeq?: number;
};

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type StepLogEntry = {
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: JsonValue;
};

export type ArtifactReference = {
  id: string;
  contentType: string;
  sizeBytes: number;
  label?: string;
};

export type StepRun = {
  id: string;
  runId: string;
  nodeId: string;
  attempt: number;
  status: StepRunStatus;
  /** Resolved configuration with sensitive values masked. */
  resolvedInput?: JsonValue;
  outputPreview?: JsonValue;
  error?: ErrorInfo;
  logs: StepLogEntry[];
  artifacts: ArtifactReference[];
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
};

export type Artifact = {
  id: string;
  runId: string;
  stepRunId: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
};

/**
 * Breakpoint context persisted when a Run pauses. Previews are masked and size-capped; this
 * record never holds unmasked secrets.
 */
export type RunPause = {
  id: string;
  runId: string;
  breakpointStepRunId: string;
  breakpointNodeId: string;
  /** Sanitized author-provided message. */
  message?: string;
  /** Successor node, or null when the Breakpoint ends the flow. */
  nextNodeId: string | null;
  nextNodeName?: string;
  nextNodeType?: string;
  /** Masked, size-capped input the successor would receive. */
  nextResolvedInputPreview?: JsonValue;
  nextInputArtifactId?: string;
  pausedAt: string;
  /** Run continuation generation at the time of the pause; guards resume idempotency. */
  continuationGeneration: number;
  resumedAt?: string;
  cancelledAt?: string;
};

/** Completed Step summary shown beside a pause; full detail stays on the Step Run. */
export type PausedStepSummary = Pick<
  StepRun,
  | 'id'
  | 'nodeId'
  | 'attempt'
  | 'status'
  | 'outputPreview'
  | 'startedAt'
  | 'finishedAt'
  | 'durationMs'
>;

/** Aggregated read model for `GET /runs/{id}/pause`. */
export type RunPauseInspection = {
  pause: RunPause;
  completedSteps: PausedStepSummary[];
};
