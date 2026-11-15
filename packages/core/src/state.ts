import type { RunStatus, StepRunStatus } from '@test-platform/contracts';
import { PlatformError } from './errors.js';

const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  Queued: ['Running', 'Cancelled'],
  // Running -> Paused at an enabled Breakpoint; Paused -> Queued is a resume request.
  Running: ['Succeeded', 'Failed', 'Cancelling', 'Queued', 'Paused'],
  Paused: ['Queued', 'Cancelled'],
  Cancelling: ['Cancelled'],
  Succeeded: [],
  Failed: [],
  Cancelled: [],
};

const STEP_RUN_TRANSITIONS: Record<StepRunStatus, readonly StepRunStatus[]> = {
  Queued: ['Running', 'Skipped', 'Cancelled'],
  Running: ['Succeeded', 'Failed', 'Retrying', 'Cancelled', 'Paused'],
  // A paused Breakpoint attempt finishes as Succeeded on resume, or Cancelled with its Run.
  Paused: ['Succeeded', 'Cancelled'],
  Retrying: ['Running', 'Cancelled'],
  Succeeded: [],
  Failed: [],
  Skipped: [],
  Cancelled: [],
};

/** `noop` makes repeated requests for the state already reached idempotent. */
export type TransitionDecision = 'apply' | 'noop' | 'reject';

const decide = <S extends string>(
  table: Record<S, readonly S[]>,
  from: S,
  to: S,
): TransitionDecision => {
  if (from === to) return 'noop';
  return table[from].includes(to) ? 'apply' : 'reject';
};

export const decideRunTransition = (from: RunStatus, to: RunStatus): TransitionDecision =>
  decide(RUN_TRANSITIONS, from, to);
export const decideStepRunTransition = (
  from: StepRunStatus,
  to: StepRunStatus,
): TransitionDecision => decide(STEP_RUN_TRANSITIONS, from, to);

/** A Run waiting at a Breakpoint holds no worker lease but is not finished. */
export const isPausedRunStatus = (status: RunStatus): boolean => status === 'Paused';

export const isTerminalRunStatus = (status: RunStatus): boolean =>
  RUN_TRANSITIONS[status].length === 0;
export const isTerminalStepRunStatus = (status: StepRunStatus): boolean =>
  STEP_RUN_TRANSITIONS[status].length === 0;

export const assertRunTransition = (from: RunStatus, to: RunStatus): TransitionDecision => {
  const decision = decideRunTransition(from, to);
  if (decision === 'reject') {
    throw new PlatformError(
      'EXECUTION_INVALID_TRANSITION',
      `Run cannot move from ${from} to ${to}.`,
    );
  }
  return decision;
};

export const assertStepRunTransition = (
  from: StepRunStatus,
  to: StepRunStatus,
): TransitionDecision => {
  const decision = decideStepRunTransition(from, to);
  if (decision === 'reject') {
    throw new PlatformError(
      'EXECUTION_INVALID_TRANSITION',
      `Step run cannot move from ${from} to ${to}.`,
    );
  }
  return decision;
};

/**
 * Guards a resume request. `expectedGeneration` is the continuation generation the caller
 * inspected; a different value means the caller is acting on a stale pause.
 */
export type ResumeDecision =
  { kind: 'resume' } | { kind: 'duplicate' } | { kind: 'stale' } | { kind: 'not-paused' };

export const decideResume = (input: {
  runStatus: RunStatus;
  currentGeneration: number;
  /** Generation of the active pause; only meaningful while the Run is Paused. */
  activePauseGeneration?: number;
  /** Generation the caller expects; omitted means "whatever pause is active". */
  expectedGeneration?: number;
  /** True when a pause for `expectedGeneration` was already resumed. */
  expectedGenerationResumed?: boolean;
}): ResumeDecision => {
  if (input.runStatus === 'Paused') {
    if (
      input.expectedGeneration !== undefined &&
      input.expectedGeneration !== input.activePauseGeneration
    )
      return { kind: 'stale' };
    return { kind: 'resume' };
  }
  if (
    input.expectedGeneration !== undefined &&
    input.expectedGenerationResumed &&
    input.currentGeneration === input.expectedGeneration + 1
  )
    return { kind: 'duplicate' };
  return { kind: 'not-paused' };
};
