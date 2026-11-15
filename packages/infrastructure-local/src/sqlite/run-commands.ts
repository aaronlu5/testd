import type { Run } from '@test-platform/contracts';
import {
  systemClock,
  type CancelRequest,
  type Clock,
  type Job,
  type RunCommands,
  type RunSubmission,
  type TransitionResult,
} from '@test-platform/core';
import type { SqliteAuditLog, SqliteRunEvents } from './audit-and-events.js';
import { transaction, type Database } from './database.js';
import type { SqliteJobQueue } from './job-queue.js';
import type { SqliteRunPauseRepository } from './run-pause-repository.js';
import type { SqliteRunRepository } from './run-repository.js';

export type SqliteRunCommandsOptions = {
  db: Database;
  runs: SqliteRunRepository;
  jobs: SqliteJobQueue;
  events: SqliteRunEvents;
  audit: SqliteAuditLog;
  /** When set, cancelling a Paused Run cancels the pause and its Breakpoint Step Run. */
  pauses?: SqliteRunPauseRepository;
  clock?: Clock;
};

/** All-or-nothing writes spanning runs, jobs, events, and audit records in one transaction. */
export class SqliteRunCommands implements RunCommands {
  readonly #options: SqliteRunCommandsOptions;
  readonly #clock: Clock;

  constructor(options: SqliteRunCommandsOptions) {
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
  }

  async submit(submission: RunSubmission): Promise<{ run: Run; job: Job }> {
    return this.submitSync(submission);
  }

  /** Synchronous so callers (for example Suite dispatch) can compose it into a larger transaction. */
  submitSync(submission: RunSubmission): { run: Run; job: Job } {
    const { db, runs, jobs, events, audit } = this.#options;
    return transaction(db, () => {
      runs.insertRun(submission.run);
      const job = jobs.enqueueSync({
        runId: submission.run.id,
        maxAttempts: submission.maxAttempts,
      });
      events.publishSync({
        type: 'run.status',
        runId: submission.run.id,
        timestamp: this.#clock.now().toISOString(),
        data: { status: submission.run.status },
      });
      if (submission.audit) audit.appendSync(submission.audit);
      // Re-read so the stored Run number (assigned on insert) is on the returned Run.
      return { run: runs.getRunSync(submission.run.id) ?? submission.run, job };
    });
  }

  async requestCancel(request: CancelRequest): Promise<TransitionResult<Run>> {
    return this.requestCancelSync(request);
  }

  /**
   * Queued -> Cancelled, Running -> Cancelling, Paused -> Cancelled (directly, with its Breakpoint
   * Step Run). A Run that is already final or cancelling is a no-op.
   */
  requestCancelSync(request: CancelRequest): TransitionResult<Run> {
    const { db, runs, jobs, events, audit, pauses } = this.#options;
    return transaction(db, () => {
      const existing = runs.getRunSync(request.runId);
      if (existing?.status === 'Paused' && pauses) {
        const result = pauses.cancelPausedSync({
          runId: request.runId,
          at: request.at,
          audit: request.audit,
        });
        if (result.outcome === 'applied') return { outcome: 'applied', current: result.run };
        return { outcome: result.outcome === 'noop' ? 'noop' : 'rejected', current: result.run };
      }

      const result = runs.requestCancelSync(request.runId, request.at);
      if (result.outcome === 'applied' && result.current) {
        if (result.current.status === 'Cancelled') jobs.cancelQueuedSync(request.runId);
        events.publishSync({
          type: 'run.status',
          runId: request.runId,
          timestamp: request.at,
          data: { status: result.current.status },
        });
        if (request.audit) audit.appendSync(request.audit);
      }
      return result;
    });
  }
}
