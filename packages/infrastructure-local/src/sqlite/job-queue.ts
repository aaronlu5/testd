import {
  systemClock,
  type Clock,
  type Job,
  type JobQueue,
  type JobStatus,
  type Outcome,
} from '@test-platform/core';
import { newId } from '../ids.js';
import { transaction, type Database, type Row } from './database.js';

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ERROR_LENGTH = 1000;

const toJob = (row: Row): Job => {
  const job: Job = {
    id: row.id as string,
    runId: row.run_id as string,
    status: row.status as JobStatus,
    availableAt: row.available_at as string,
    attempts: row.attempts as number,
    maxAttempts: row.max_attempts as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
  if (typeof row.lease_owner === 'string') job.leaseOwner = row.lease_owner;
  if (typeof row.lease_expires_at === 'string') job.leaseExpiresAt = row.lease_expires_at;
  if (typeof row.last_error === 'string') job.lastError = row.last_error;
  return job;
};

const truncate = (value: string | undefined): string | null =>
  value === undefined ? null : value.slice(0, MAX_ERROR_LENGTH);

/**
 * Durable job queue on SQLite. Every state change runs in an IMMEDIATE transaction and is
 * conditional on the expected status and lease owner, so repeated or racing calls are safe.
 */
export class SqliteJobQueue implements JobQueue {
  readonly #db: Database;
  readonly #clock: Clock;

  constructor(db: Database, clock: Clock = systemClock) {
    this.#db = db;
    this.#clock = clock;
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }

  #at(offsetMs: number): string {
    return new Date(this.#clock.now().getTime() + offsetMs).toISOString();
  }

  async enqueue(input: {
    runId: string;
    availableAt?: string;
    maxAttempts?: number;
  }): Promise<Job> {
    return this.enqueueSync(input);
  }

  /** Synchronous so callers can compose it into a larger transaction. */
  enqueueSync(input: { runId: string; availableAt?: string; maxAttempts?: number }): Job {
    const now = this.#now();
    const id = newId();
    this.#db
      .prepare(
        `INSERT INTO jobs (id, run_id, status, available_at, attempts, max_attempts, created_at, updated_at)
         VALUES (?, ?, 'queued', ?, 0, ?, ?, ?)`,
      )
      .run(
        id,
        input.runId,
        input.availableAt ?? now,
        input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        now,
        now,
      );
    return this.getSync(id) as Job;
  }

  async claim(input: { workerId: string; leaseMs: number }): Promise<Job | undefined> {
    return transaction(this.#db, () => {
      const now = this.#now();
      const row = this.#db
        .prepare(
          `SELECT id FROM jobs WHERE status = 'queued' AND available_at <= ?
           ORDER BY available_at, created_at, id LIMIT 1`,
        )
        .get(now) as Row | undefined;
      if (!row) return undefined;

      this.#db
        .prepare(
          `UPDATE jobs SET status = 'leased', lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
           WHERE id = ? AND status = 'queued'`,
        )
        .run(input.workerId, this.#at(input.leaseMs), now, row.id as string);
      return toJob(
        this.#db.prepare('SELECT * FROM jobs WHERE id = ?').get(row.id as string) as Row,
      );
    });
  }

  async renewLease(input: { jobId: string; workerId: string; leaseMs: number }): Promise<boolean> {
    const result = this.#db
      .prepare(
        `UPDATE jobs SET lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'leased' AND lease_owner = ?`,
      )
      .run(this.#at(input.leaseMs), this.#now(), input.jobId, input.workerId);
    return Number(result.changes) === 1;
  }

  /** Leased -> `target`, only for the lease owner. Repeating a finished transition is a no-op. */
  #finish(
    jobId: string,
    workerId: string,
    target: 'completed' | 'failed' | 'queued',
    patch: { availableAt?: string; error?: string },
  ): Outcome {
    return transaction(this.#db, () => {
      const row = this.#db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Row | undefined;
      if (!row) return 'rejected';

      if (row.status === 'leased' && row.lease_owner === workerId) {
        this.#db
          .prepare(
            `UPDATE jobs SET status = ?, lease_owner = NULL, lease_expires_at = NULL, available_at = ?,
               last_error = COALESCE(?, last_error), updated_at = ?
             WHERE id = ?`,
          )
          .run(
            target,
            patch.availableAt ?? (row.available_at as string),
            truncate(patch.error),
            this.#now(),
            jobId,
          );
        return 'applied';
      }
      // Terminal states already reached are idempotent; queued repeats are too (lease already released).
      return row.status === target && target !== 'queued' ? 'noop' : 'rejected';
    });
  }

  async complete(input: { jobId: string; workerId: string }): Promise<Outcome> {
    return this.#finish(input.jobId, input.workerId, 'completed', {});
  }

  async reschedule(input: {
    jobId: string;
    workerId: string;
    availableAt: string;
    error?: string;
  }): Promise<Outcome> {
    return this.#finish(input.jobId, input.workerId, 'queued', {
      availableAt: input.availableAt,
      error: input.error,
    });
  }

  async fail(input: { jobId: string; workerId: string; error: string }): Promise<Outcome> {
    return this.#finish(input.jobId, input.workerId, 'failed', { error: input.error });
  }

  async cancelQueued(runId: string): Promise<boolean> {
    return this.cancelQueuedSync(runId);
  }

  /** Synchronous so callers can compose it into a larger transaction. */
  cancelQueuedSync(runId: string): boolean {
    const result = this.#db
      .prepare(
        `UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE run_id = ? AND status = 'queued'`,
      )
      .run(this.#now(), runId);
    return Number(result.changes) > 0;
  }

  async recoverExpired(): Promise<{ requeued: number; failed: number; runsFailed?: number }> {
    return transaction(this.#db, () => {
      const now = this.#now();
      const exhausted = this.#db
        .prepare(
          `SELECT run_id FROM jobs
           WHERE status = 'leased' AND lease_expires_at <= ? AND attempts >= max_attempts`,
        )
        .all(now) as Row[];
      const failed = this.#db
        .prepare(
          `UPDATE jobs SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
             last_error = 'Lease expired and the maximum number of attempts was reached.', updated_at = ?
           WHERE status = 'leased' AND lease_expires_at <= ? AND attempts >= max_attempts`,
        )
        .run(now, now);
      const requeued = this.#db
        .prepare(
          `UPDATE jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, available_at = ?,
             last_error = 'Lease expired before the job completed.', updated_at = ?
           WHERE status = 'leased' AND lease_expires_at <= ?`,
        )
        .run(now, now, now);

      // The Run would otherwise stay active forever with no job left to finish it.
      let runsFailed = 0;
      for (const { run_id: runId } of exhausted) {
        const run = this.#db
          .prepare('SELECT status FROM runs WHERE id = ?')
          .get(runId as string) as Row | undefined;
        if (!run) continue;
        const target =
          run.status === 'Cancelling'
            ? 'Cancelled'
            : run.status === 'Running' || run.status === 'Queued'
              ? 'Failed'
              : undefined;
        if (!target) continue;
        const error = JSON.stringify({
          code: 'EXECUTION_LEASE',
          message: 'The Run was abandoned: its worker stopped repeatedly and no attempts remain.',
        });
        this.#db
          .prepare(
            `UPDATE runs SET status = ?, finished_at = ?, error = CASE WHEN ? = 'Failed' THEN ? ELSE error END
             WHERE id = ? AND status IN ('Running', 'Queued', 'Cancelling')`,
          )
          .run(target, now, target, error, runId as string);
        this.#db
          .prepare('INSERT INTO run_events (run_id, type, at, payload) VALUES (?, ?, ?, ?)')
          .run(runId as string, 'run.status', now, JSON.stringify({ status: target }));
        runsFailed += 1;
      }
      // runsFailed is only present when a Run had to be closed, keeping the Phase 1 result shape.
      return {
        requeued: Number(requeued.changes),
        failed: Number(failed.changes),
        ...(runsFailed > 0 ? { runsFailed } : {}),
      };
    });
  }

  async get(jobId: string): Promise<Job | undefined> {
    return this.getSync(jobId);
  }

  getSync(jobId: string): Job | undefined {
    const row = this.#db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Row | undefined;
    return row ? toJob(row) : undefined;
  }
}
