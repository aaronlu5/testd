import type {
  Artifact,
  AssetOf,
  AssetType,
  EnvironmentTarget,
  InspectorWatchInput,
  ErrorInfo,
  JsonObject,
  PausedStepSummary,
  RunEvent,
  Run,
  RunKind,
  RunPause,
  RunStatus,
  StepRun,
  StepRunStatus,
  SuiteRun,
  SuiteRunCounts,
  SuiteRunItem,
  SuiteRunItemStatus,
  SuiteRunStatus,
  TargetKind,
  ValidationIssue,
} from '@test-platform/contracts';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export type Outcome = 'applied' | 'noop' | 'rejected';
export type TransitionResult<T> = { outcome: Outcome; current?: T };

// --- Definitions ---------------------------------------------------------------------------

export type AssetSummary = {
  id: string;
  type: AssetType;
  name: string;
  tags: string[];
  currentVersion: number;
  contentHash: string;
  updatedAt: string;
};

export type StoredAsset<T extends AssetType = AssetType> = {
  type: T;
  asset: AssetOf<T>;
  contentHash: string;
};

export type AssetVersionRecord = {
  version: number;
  contentHash: string;
  createdAt: string;
  createdBy: string;
};

/** Callers never choose `version` or `metadata`; the repository assigns them. */
export type SaveAssetInput<T extends AssetType> = Omit<AssetOf<T>, 'version' | 'metadata'>;

export type SaveAssetOptions = {
  actor: string;
  /** Version the caller last read; omit when creating. A mismatch raises VALIDATION_CONFLICT. */
  expectedVersion?: number;
};

export type ReconcileReport = {
  added: string[];
  updated: string[];
  removed: string[];
  unchanged: number;
  invalid: { path: string; issues: ValidationIssue[] }[];
};

export interface DefinitionRepository {
  list(type: AssetType, filter?: { tag?: string; search?: string }): Promise<AssetSummary[]>;
  get<T extends AssetType>(
    type: T,
    id: string,
    version?: number,
  ): Promise<StoredAsset<T> | undefined>;
  save<T extends AssetType>(
    type: T,
    asset: SaveAssetInput<T>,
    options: SaveAssetOptions,
  ): Promise<StoredAsset<T>>;
  listVersions(type: AssetType, id: string): Promise<AssetVersionRecord[]>;
  delete(type: AssetType, id: string, actor: string): Promise<boolean>;
  /** Rebuilds the metadata index from the authoritative JSON files. */
  reconcile(): Promise<ReconcileReport>;
}

// --- Runs ----------------------------------------------------------------------------------

export type RunFilter = {
  status?: RunStatus;
  kind?: RunKind;
  testId?: string;
  environmentId?: string;
  parentRunId?: string;
  limit?: number;
  offset?: number;
};

export type RunTransition = {
  /** Statuses the run must currently be in for the transition to apply. */
  from: RunStatus | readonly RunStatus[];
  to: RunStatus;
  at: string;
  error?: ErrorInfo;
};

export type StepRunPatch = Partial<Omit<StepRun, 'id' | 'runId' | 'nodeId' | 'attempt'>>;

export interface RunRepository {
  createRun(run: Run): Promise<void>;
  getRun(id: string): Promise<Run | undefined>;
  listRuns(filter?: RunFilter): Promise<Run[]>;
  transitionRun(id: string, transition: RunTransition): Promise<TransitionResult<Run>>;
  /** Queued -> Cancelled, Running -> Cancelling; already-final states are a no-op. */
  requestCancel(id: string, at: string): Promise<TransitionResult<Run>>;
  createStepRun(stepRun: StepRun): Promise<void>;
  updateStepRun(
    id: string,
    patch: StepRunPatch,
    expectedStatus?: StepRunStatus | readonly StepRunStatus[],
  ): Promise<TransitionResult<StepRun>>;
  getStepRun(id: string): Promise<StepRun | undefined>;
  listStepRuns(runId: string): Promise<StepRun[]>;
}

// --- Breakpoint pauses -----------------------------------------------------------------------

/** Context captured by the worker when it reaches an enabled Breakpoint. */
export type NewRunPause = Omit<
  RunPause,
  'id' | 'runId' | 'breakpointStepRunId' | 'continuationGeneration' | 'resumedAt' | 'cancelledAt'
>;

export type PauseRunInput = {
  runId: string;
  /** Job whose lease the worker holds; it is completed (lease released) with the pause. */
  jobId: string;
  workerId: string;
  /** Step Run of the Breakpoint; must currently be `Running`. */
  breakpointStepRunId: string;
  pause: NewRunPause;
};

export type PauseRunResult =
  | { outcome: 'applied'; pause: RunPause; run: Run }
  | { outcome: 'rejected'; reason: 'run-not-running' | 'lease-lost' | 'step-not-running' };

export type ResumeRunInput = {
  runId: string;
  at: string;
  /** Continuation generation the caller inspected; a mismatch is a stale command. */
  expectedGeneration?: number;
  audit?: AuditEvent;
};

export type ResumeRunResult =
  | { outcome: 'applied'; pause: RunPause; run: Run; job: Job }
  | { outcome: 'noop'; run: Run }
  | { outcome: 'rejected'; reason: 'not-found' | 'not-paused' | 'stale-generation'; run?: Run };

export type CancelPausedInput = { runId: string; at: string; audit?: AuditEvent };

export type CancelPausedResult =
  | { outcome: 'applied'; run: Run; pause: RunPause }
  | { outcome: 'noop'; run: Run }
  | { outcome: 'rejected'; reason: 'not-found' | 'not-paused'; run?: Run };

/**
 * Durable pause lifecycle. Every write validates the expected state in one transaction so a
 * stale worker or a repeated command cannot overwrite a cancellation or another continuation.
 */
export interface RunPauseRepository {
  pauseRun(input: PauseRunInput): Promise<PauseRunResult>;
  getActivePause(runId: string): Promise<RunPause | undefined>;
  /** The pause recorded for a given continuation generation, active or resolved. */
  getPause(runId: string, continuationGeneration: number): Promise<RunPause | undefined>;
  listPauses(runId: string): Promise<RunPause[]>;
  /** Paused -> Queued with generation + 1 and a new job; repeats for one generation are no-ops. */
  resumeRun(input: ResumeRunInput): Promise<ResumeRunResult>;
  /** Paused -> Cancelled, with the Breakpoint Step Run cancelled in the same transaction. */
  cancelPausedRun(input: CancelPausedInput): Promise<CancelPausedResult>;
  /** Completed Step summaries for the pause inspection model. */
  listCompletedSteps(runId: string): Promise<PausedStepSummary[]>;
}

// --- Suite Runs -------------------------------------------------------------------------------

export type NewSuiteRun = {
  suiteRun: SuiteRun;
  /** One item per Suite item, in order, all `Pending`. */
  items: SuiteRunItem[];
};

export type SuiteRunFilter = { status?: SuiteRunStatus; limit?: number; offset?: number };

export type SuiteRunTransition = {
  from: SuiteRunStatus | readonly SuiteRunStatus[];
  to: SuiteRunStatus;
  at: string;
  error?: ErrorInfo;
};

export type SuiteItemUpdate = {
  status: SuiteRunItemStatus;
  runId?: string;
  at: string;
};

/** Parent/child Suite Run coordination data. Scheduling logic arrives in a later increment. */
export interface SuiteRunRepository {
  createSuiteRun(input: NewSuiteRun): Promise<void>;
  getSuiteRun(id: string): Promise<SuiteRun | undefined>;
  listSuiteRuns(filter?: SuiteRunFilter): Promise<SuiteRun[]>;
  /** Suite Runs that still need scheduling (not in a final state). */
  listActiveSuiteRuns(): Promise<SuiteRun[]>;
  listItems(suiteRunId: string): Promise<SuiteRunItem[]>;
  counts(suiteRunId: string): Promise<SuiteRunCounts>;
  transitionSuiteRun(
    id: string,
    transition: SuiteRunTransition,
  ): Promise<TransitionResult<SuiteRun>>;
  /**
   * Atomically claims up to `limit` Pending items (in position order) for dispatch, never letting
   * active items exceed the Suite Run's concurrency. Returns the claimed items.
   */
  claimPendingItems(suiteRunId: string, at: string): Promise<SuiteRunItem[]>;
  updateItem(
    itemId: string,
    update: SuiteItemUpdate,
    expectedStatus?: SuiteRunItemStatus | readonly SuiteRunItemStatus[],
  ): Promise<TransitionResult<SuiteRunItem>>;
  findItemByRunId(runId: string): Promise<SuiteRunItem | undefined>;
}

// --- Queue ---------------------------------------------------------------------------------

export type JobStatus = 'queued' | 'leased' | 'completed' | 'failed' | 'cancelled';

export type Job = {
  id: string;
  runId: string;
  status: JobStatus;
  availableAt: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  attempts: number;
  maxAttempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export interface JobQueue {
  enqueue(input: { runId: string; availableAt?: string; maxAttempts?: number }): Promise<Job>;
  claim(input: { workerId: string; leaseMs: number }): Promise<Job | undefined>;
  renewLease(input: { jobId: string; workerId: string; leaseMs: number }): Promise<boolean>;
  complete(input: { jobId: string; workerId: string }): Promise<Outcome>;
  /** Returns the job to the queue (for example for retry backoff) and releases the lease. */
  reschedule(input: {
    jobId: string;
    workerId: string;
    availableAt: string;
    error?: string;
  }): Promise<Outcome>;
  fail(input: { jobId: string; workerId: string; error: string }): Promise<Outcome>;
  /** Cancels a job that has not been claimed yet. */
  cancelQueued(runId: string): Promise<boolean>;
  /** Requeues jobs whose lease expired; jobs out of attempts are failed. */
  recoverExpired(): Promise<{ requeued: number; failed: number; runsFailed?: number }>;
  get(jobId: string): Promise<Job | undefined>;
}

// --- Run commands ---------------------------------------------------------------------------

export type RunSubmission = {
  /** A Run in status Queued with its snapshots already captured. */
  run: Run;
  maxAttempts?: number;
  audit?: AuditEvent;
};

export type CancelRequest = { runId: string; at: string; audit?: AuditEvent };

/**
 * Multi-step writes that must be all-or-nothing. `submit` stores the Run, queues its job,
 * publishes the initial event, and writes the audit record together. `requestCancel` moves the
 * Run, cancels an unclaimed job, and publishes the event together.
 */
export interface RunCommands {
  submit(submission: RunSubmission): Promise<{ run: Run; job: Job }>;
  requestCancel(request: CancelRequest): Promise<TransitionResult<Run>>;
}

// --- Artifacts, secrets, targets, events, audit, logging -----------------------------------

export type ArtifactWrite = {
  runId: string;
  stepRunId: string;
  content: Uint8Array | string;
  contentType: string;
};

export interface ArtifactStore {
  write(input: ArtifactWrite): Promise<Artifact>;
  get(artifactId: string): Promise<Artifact | undefined>;
  read(artifactId: string): Promise<{ artifact: Artifact; content: Uint8Array } | undefined>;
}

/** Phase 1 name-only lookup (`localPlainText` semantics); prefer `SecretReferenceResolver`. */
export interface SecretProvider {
  getSecret(name: string): Promise<string | undefined>;
  /** Values currently known to be sensitive, for redaction. */
  sensitiveValues(): Iterable<string>;
}

export type TargetOf<K extends TargetKind> = Extract<EnvironmentTarget, { kind: K }>;

/** Resolves logical target names against the active Environment allowlist. */
export interface TargetResolver {
  resolve<K extends TargetKind>(name: string, kind: K): TargetOf<K>;
}

export interface EventPublisher {
  publish(event: RunEvent): Promise<void>;
}

export interface RunEventSource {
  listSince(runId: string, afterSeq?: number, limit?: number): Promise<RunEvent[]>;
  /** Highest sequence number recorded for `runId` (0 when it has no events). */
  lastSeq(runId: string): Promise<number>;
}

export type AuditEvent = {
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  at?: string;
  metadata?: JsonObject;
};

export interface AuditLog {
  append(event: AuditEvent): Promise<void>;
}

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

/** A message a Service Bus Step just sent, handed to the inspector. Masking happens in the sink. */
export type InspectorSentMessage = {
  environmentId: string;
  target: string;
  entity: string;
  subscription?: string;
  messageId: string;
  correlationId: string;
  subject?: string;
  contentType: string;
  applicationProperties: Record<string, string | number | boolean>;
  body: Uint8Array;
  runId: string;
  stepRunId: string;
  nodeId: string;
};

/** What a Step may do with the Service Bus Inspector. Both calls are idempotent and best-effort. */
export interface InspectorSink {
  /** Registers the watch if it does not exist yet; returns whether it was created. */
  registerWatch(input: InspectorWatchInput & { createdBy: string }): Promise<{ created: boolean }>;
  recordSent(message: InspectorSentMessage): Promise<void>;
}
