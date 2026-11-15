import type { SuiteRunCounts, SuiteRunItemStatus, SuiteRunStatus } from '@test-platform/contracts';
import { SUITE_RUN_ITEM_STATUSES } from '@test-platform/contracts';
import type { TransitionDecision } from './state.js';

const SUITE_RUN_TRANSITIONS: Record<SuiteRunStatus, readonly SuiteRunStatus[]> = {
  Queued: ['Running', 'Cancelled'],
  Running: ['WaitingForBreakpoint', 'Succeeded', 'Failed', 'Cancelling', 'Cancelled'],
  WaitingForBreakpoint: ['Running', 'Succeeded', 'Failed', 'Cancelling', 'Cancelled'],
  Cancelling: ['Cancelled'],
  Succeeded: [],
  Failed: [],
  Cancelled: [],
};

// Items mirror their child Test Run, so a scheduler that polls late may see a child that has
// already moved past the next state; every non-final state may jump to any child state.
const SUITE_ITEM_TRANSITIONS: Record<SuiteRunItemStatus, readonly SuiteRunItemStatus[]> = {
  Pending: ['Queued', 'Skipped', 'Cancelled'],
  Queued: ['Running', 'Paused', 'Succeeded', 'Failed', 'Cancelling', 'Cancelled'],
  Running: ['Queued', 'Paused', 'Succeeded', 'Failed', 'Cancelling', 'Cancelled'],
  Paused: ['Queued', 'Running', 'Succeeded', 'Failed', 'Cancelling', 'Cancelled'],
  Cancelling: ['Succeeded', 'Failed', 'Cancelled'],
  Succeeded: [],
  Failed: [],
  Cancelled: [],
  Skipped: [],
};

const decide = <S extends string>(
  table: Record<S, readonly S[]>,
  from: S,
  to: S,
): TransitionDecision => (from === to ? 'noop' : table[from].includes(to) ? 'apply' : 'reject');

export const decideSuiteRunTransition = (
  from: SuiteRunStatus,
  to: SuiteRunStatus,
): TransitionDecision => decide(SUITE_RUN_TRANSITIONS, from, to);

export const decideSuiteItemTransition = (
  from: SuiteRunItemStatus,
  to: SuiteRunItemStatus,
): TransitionDecision => decide(SUITE_ITEM_TRANSITIONS, from, to);

export const isTerminalSuiteRunStatus = (status: SuiteRunStatus): boolean =>
  SUITE_RUN_TRANSITIONS[status].length === 0;
export const isTerminalSuiteItemStatus = (status: SuiteRunItemStatus): boolean =>
  SUITE_ITEM_TRANSITIONS[status].length === 0;

/** Maps a child Test Run status onto the Suite item status that mirrors it. */
export const suiteItemStatusForRun = (
  runStatus: 'Queued' | 'Running' | 'Paused' | 'Cancelling' | 'Succeeded' | 'Failed' | 'Cancelled',
): SuiteRunItemStatus => runStatus;

export const emptySuiteCounts = (): SuiteRunCounts => ({
  total: 0,
  ...(Object.fromEntries(SUITE_RUN_ITEM_STATUSES.map((status) => [status, 0])) as Record<
    SuiteRunItemStatus,
    number
  >),
});

export const countSuiteItems = (statuses: Iterable<SuiteRunItemStatus>): SuiteRunCounts => {
  const counts = emptySuiteCounts();
  for (const status of statuses) {
    counts[status] += 1;
    counts.total += 1;
  }
  return counts;
};

/** Items holding a concurrency slot. A paused child keeps its slot until it resumes or is cancelled. */
export const activeSuiteItemCount = (counts: SuiteRunCounts): number =>
  counts.Queued + counts.Running + counts.Paused + counts.Cancelling;

/** How many more Pending items may be dispatched without exceeding `maxConcurrency`. */
export const availableDispatchSlots = (counts: SuiteRunCounts, maxConcurrency: number): number =>
  Math.max(0, Math.min(maxConcurrency - activeSuiteItemCount(counts), counts.Pending));

/**
 * Parent status implied by child states. `cancelRequested` keeps a Suite Run Cancelling until
 * its active children finish. Terminal parents never revert.
 */
export const deriveSuiteRunStatus = (
  counts: SuiteRunCounts,
  options: { cancelRequested: boolean; started: boolean },
): SuiteRunStatus => {
  const active = activeSuiteItemCount(counts);
  if (options.cancelRequested) {
    return active > 0 ? 'Cancelling' : 'Cancelled';
  }
  if (counts.total > 0 && counts.Pending === 0 && active === 0) {
    return counts.Failed > 0 ? 'Failed' : counts.Cancelled > 0 ? 'Cancelled' : 'Succeeded';
  }
  if (counts.Paused > 0 && counts.Queued + counts.Running === 0) return 'WaitingForBreakpoint';
  return options.started || active > 0 ? 'Running' : 'Queued';
};

/** Concurrency actually granted: requested (default 1) capped by the Environment limit (default 1). */
export const effectiveSuiteConcurrency = (
  requested: number | undefined,
  envLimit: number | undefined,
): number => Math.max(1, Math.min(requested ?? 1, envLimit ?? 1));
