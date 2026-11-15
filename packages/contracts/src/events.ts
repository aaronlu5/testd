import type { ArtifactReference, RunStatus, StepLogEntry, StepRunStatus } from './runs.js';
import type { SuiteRunCounts, SuiteRunStatus } from './suite-runs.js';

type EventBase = {
  /** Monotonic sequence assigned on persistence; clients resume with `Last-Event-ID`. */
  seq?: number;
  runId: string;
  timestamp: string;
};

export type RunStatusEvent = EventBase & {
  type: 'run.status';
  data: { status: RunStatus };
};

export type StepStatusEvent = EventBase & {
  type: 'step.status';
  data: { stepRunId: string; nodeId: string; attempt: number; status: StepRunStatus };
};

export type StepLogEvent = EventBase & {
  type: 'step.log';
  data: { stepRunId: string; entry: StepLogEntry };
};

export type ArtifactCreatedEvent = EventBase & {
  type: 'artifact.created';
  data: { stepRunId: string; artifact: ArtifactReference };
};

export type RunPausedEvent = EventBase & {
  type: 'run.paused';
  data: {
    pauseId: string;
    breakpointStepRunId: string;
    breakpointNodeId: string;
    nextNodeId: string | null;
    continuationGeneration: number;
    pausedAt: string;
  };
};

export type RunResumedEvent = EventBase & {
  type: 'run.resumed';
  /** `continuationGeneration` is the new generation the Run continues under. */
  data: { pauseId: string; continuationGeneration: number; resumedAt: string };
};

export type RunCancelledEvent = EventBase & {
  type: 'run.cancelled';
  data: { cancelledAt: string; whilePaused: boolean };
};

/** Step-run lifecycle change; additive to `step.status` for Phase 2 consumers. */
export type RunStepUpdatedEvent = EventBase & {
  type: 'run.step.updated';
  data: { stepRunId: string; nodeId: string; attempt: number; status: StepRunStatus };
};

export type RunEvent =
  | RunStatusEvent
  | StepStatusEvent
  | StepLogEvent
  | ArtifactCreatedEvent
  | RunPausedEvent
  | RunResumedEvent
  | RunCancelledEvent
  | RunStepUpdatedEvent;
export type RunEventType = RunEvent['type'];

/** Suite Run progress; keyed by `suiteRunId` because it is not scoped to one Test Run. */
export type SuiteRunUpdatedEvent = {
  seq?: number;
  type: 'suiteRun.updated';
  suiteRunId: string;
  timestamp: string;
  data: { status: SuiteRunStatus; counts: SuiteRunCounts };
};
