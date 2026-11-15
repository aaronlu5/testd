import type { PausedStepSummary, RunPause } from '@test-platform/contracts';
import {
  decideResume,
  systemClock,
  type CancelPausedInput,
  type CancelPausedResult,
  type Clock,
  type PauseRunInput,
  type PauseRunResult,
  type ResumeRunInput,
  type ResumeRunResult,
  type RunPauseRepository,
} from '@test-platform/core';
import { newId } from '../ids.js';
import type { SqliteAuditLog, SqliteRunEvents } from './audit-and-events.js';
import { fromJson, toJson, transaction, type Database, type Row } from './database.js';
import type { SqliteJobQueue } from './job-queue.js';
import { rowToRun, rowToStepRun } from './run-repository.js';

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

export const rowToRunPause = (row: Row): RunPause => {
  const pause: RunPause = {
    id: row.id as string,
    runId: row.run_id as string,
    breakpointStepRunId: row.breakpoint_step_run_id as string,
    breakpointNodeId: row.breakpoint_node_id as string,
    nextNodeId: text(row.next_node_id) ?? null,
    pausedAt: row.paused_at as string,
    continuationGeneration: row.continuation_generation as number,
  };
  const message = text(row.message);
  const nextNodeName = text(row.next_node_name);
  const nextNodeType = text(row.next_node_type);
  const preview = fromJson<RunPause['nextResolvedInputPreview']>(row.next_resolved_input_preview);
  if (message !== undefined) pause.message = message;
  if (nextNodeName !== undefined) pause.nextNodeName = nextNodeName;
  if (nextNodeType !== undefined) pause.nextNodeType = nextNodeType;
  if (preview !== undefined) pause.nextResolvedInputPreview = preview;
  if (text(row.next_input_artifact_id))
    pause.nextInputArtifactId = row.next_input_artifact_id as string;
  if (text(row.resumed_at)) pause.resumedAt = row.resumed_at as string;
  if (text(row.cancelled_at)) pause.cancelledAt = row.cancelled_at as string;
  return pause;
};

export type SqlitePauseRepositoryOptions = {
  db: Database;
  jobs: SqliteJobQueue;
  events: SqliteRunEvents;
  audit: SqliteAuditLog;
  clock?: Clock;
};

const ACTIVE = 'resumed_at IS NULL AND cancelled_at IS NULL';

/**
 * Pause lifecycle on SQLite. Each command is one IMMEDIATE transaction that re-reads the Run,
 * pause, job lease and Step Run and applies only if they are still in the expected state, so a
 * stale worker or a duplicate command cannot overwrite a cancellation or another continuation.
 * The same writes (events, audit, job queueing) join the transaction, as `SqliteRunCommands` does.
 */
export class SqliteRunPauseRepository implements RunPauseRepository {
  readonly #options: SqlitePauseRepositoryOptions;
  readonly #clock: Clock;

  constructor(options: SqlitePauseRepositoryOptions) {
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
  }

  async pauseRun(input: PauseRunInput): Promise<PauseRunResult> {
    const { db, events } = this.#options;
    return transaction(db, () => {
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(input.jobId) as Row | undefined;
      const now = this.#clock.now().toISOString();
      if (
        !job ||
        job.run_id !== input.runId ||
        job.status !== 'leased' ||
        job.lease_owner !== input.workerId ||
        (text(job.lease_expires_at) ?? '') <= now
      )
        return { outcome: 'rejected', reason: 'lease-lost' };

      const runRow = db.prepare('SELECT * FROM runs WHERE id = ?').get(input.runId) as
        Row | undefined;
      if (!runRow || runRow.status !== 'Running')
        return { outcome: 'rejected', reason: 'run-not-running' };

      const stepRow = db
        .prepare('SELECT * FROM step_runs WHERE id = ? AND run_id = ?')
        .get(input.breakpointStepRunId, input.runId) as Row | undefined;
      if (!stepRow || stepRow.status !== 'Running')
        return { outcome: 'rejected', reason: 'step-not-running' };

      const pauseId = newId();
      const generation = (runRow.continuation_generation as number) ?? 0;
      const { pause } = input;
      db.prepare(
        `INSERT INTO run_pauses (id, run_id, breakpoint_step_run_id, breakpoint_node_id, message, next_node_id,
           next_node_name, next_node_type, next_resolved_input_preview, next_input_artifact_id, paused_at,
           continuation_generation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        pauseId,
        input.runId,
        input.breakpointStepRunId,
        pause.breakpointNodeId,
        pause.message ?? null,
        pause.nextNodeId,
        pause.nextNodeName ?? null,
        pause.nextNodeType ?? null,
        toJson(pause.nextResolvedInputPreview),
        pause.nextInputArtifactId ?? null,
        pause.pausedAt,
        generation,
      );
      db.prepare("UPDATE step_runs SET status = 'Paused' WHERE id = ? AND status = 'Running'").run(
        input.breakpointStepRunId,
      );
      db.prepare(
        "UPDATE runs SET status = 'Paused', paused_at = ? WHERE id = ? AND status = 'Running'",
      ).run(pause.pausedAt, input.runId);
      // No worker keeps a lease while a Run is paused.
      db.prepare(
        `UPDATE jobs SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'leased' AND lease_owner = ?`,
      ).run(now, input.jobId, input.workerId);

      events.publishSync({
        type: 'step.status',
        runId: input.runId,
        timestamp: pause.pausedAt,
        data: {
          stepRunId: input.breakpointStepRunId,
          nodeId: pause.breakpointNodeId,
          attempt: stepRow.attempt as number,
          status: 'Paused',
        },
      });
      events.publishSync({
        type: 'run.step.updated',
        runId: input.runId,
        timestamp: pause.pausedAt,
        data: {
          stepRunId: input.breakpointStepRunId,
          nodeId: pause.breakpointNodeId,
          attempt: stepRow.attempt as number,
          status: 'Paused',
        },
      });
      events.publishSync({
        type: 'run.status',
        runId: input.runId,
        timestamp: pause.pausedAt,
        data: { status: 'Paused' },
      });
      events.publishSync({
        type: 'run.paused',
        runId: input.runId,
        timestamp: pause.pausedAt,
        data: {
          pauseId,
          breakpointStepRunId: input.breakpointStepRunId,
          breakpointNodeId: pause.breakpointNodeId,
          nextNodeId: pause.nextNodeId,
          continuationGeneration: generation,
          pausedAt: pause.pausedAt,
        },
      });

      return {
        outcome: 'applied',
        pause: rowToRunPause(
          db.prepare('SELECT * FROM run_pauses WHERE id = ?').get(pauseId) as Row,
        ),
        run: rowToRun(db.prepare('SELECT * FROM runs WHERE id = ?').get(input.runId) as Row),
      };
    });
  }

  async getActivePause(runId: string): Promise<RunPause | undefined> {
    const row = this.#options.db
      .prepare(`SELECT * FROM run_pauses WHERE run_id = ? AND ${ACTIVE}`)
      .get(runId) as Row | undefined;
    return row ? rowToRunPause(row) : undefined;
  }

  async getPause(runId: string, continuationGeneration: number): Promise<RunPause | undefined> {
    const row = this.#options.db
      .prepare('SELECT * FROM run_pauses WHERE run_id = ? AND continuation_generation = ?')
      .get(runId, continuationGeneration) as Row | undefined;
    return row ? rowToRunPause(row) : undefined;
  }

  async listPauses(runId: string): Promise<RunPause[]> {
    const rows = this.#options.db
      .prepare('SELECT * FROM run_pauses WHERE run_id = ? ORDER BY continuation_generation')
      .all(runId) as Row[];
    return rows.map(rowToRunPause);
  }

  async resumeRun(input: ResumeRunInput): Promise<ResumeRunResult> {
    const { db, jobs, events, audit } = this.#options;
    return transaction(db, () => {
      const runRow = db.prepare('SELECT * FROM runs WHERE id = ?').get(input.runId) as
        Row | undefined;
      if (!runRow) return { outcome: 'rejected', reason: 'not-found' };
      const run = rowToRun(runRow);

      const active = db
        .prepare(`SELECT * FROM run_pauses WHERE run_id = ? AND ${ACTIVE}`)
        .get(input.runId) as Row | undefined;
      const expectedRow =
        input.expectedGeneration === undefined
          ? undefined
          : (db
              .prepare('SELECT * FROM run_pauses WHERE run_id = ? AND continuation_generation = ?')
              .get(input.runId, input.expectedGeneration) as Row | undefined);

      const decision = decideResume({
        runStatus: run.status,
        currentGeneration: run.continuationGeneration ?? 0,
        activePauseGeneration: active ? (active.continuation_generation as number) : undefined,
        expectedGeneration: input.expectedGeneration,
        expectedGenerationResumed: expectedRow ? text(expectedRow.resumed_at) !== undefined : false,
      });
      if (decision.kind === 'duplicate') return { outcome: 'noop', run };
      if (decision.kind === 'stale')
        return { outcome: 'rejected', reason: 'stale-generation', run };
      if (decision.kind === 'not-paused' || !active)
        return { outcome: 'rejected', reason: 'not-paused', run };

      const generation = active.continuation_generation as number;
      db.prepare(`UPDATE run_pauses SET resumed_at = ? WHERE id = ? AND ${ACTIVE}`).run(
        input.at,
        active.id as string,
      );
      db.prepare(
        `UPDATE runs SET status = 'Queued', continuation_generation = continuation_generation + 1,
           paused_at = NULL
         WHERE id = ? AND status = 'Paused'`,
      ).run(input.runId);
      const job = jobs.enqueueSync({ runId: input.runId });

      events.publishSync({
        type: 'run.status',
        runId: input.runId,
        timestamp: input.at,
        data: { status: 'Queued' },
      });
      events.publishSync({
        type: 'run.resumed',
        runId: input.runId,
        timestamp: input.at,
        data: {
          pauseId: active.id as string,
          continuationGeneration: generation + 1,
          resumedAt: input.at,
        },
      });
      if (input.audit) audit.appendSync(input.audit);

      return {
        outcome: 'applied',
        pause: rowToRunPause(
          db.prepare('SELECT * FROM run_pauses WHERE id = ?').get(active.id as string) as Row,
        ),
        run: rowToRun(db.prepare('SELECT * FROM runs WHERE id = ?').get(input.runId) as Row),
        job,
      };
    });
  }

  async cancelPausedRun(input: CancelPausedInput): Promise<CancelPausedResult> {
    return this.cancelPausedSync(input);
  }

  /** Synchronous so callers can compose it into a larger transaction (for example a Suite cancel). */
  cancelPausedSync(input: CancelPausedInput): CancelPausedResult {
    const { db, events, audit } = this.#options;
    return transaction(db, () => {
      const runRow = db.prepare('SELECT * FROM runs WHERE id = ?').get(input.runId) as
        Row | undefined;
      if (!runRow) return { outcome: 'rejected', reason: 'not-found' };
      const run = rowToRun(runRow);

      const active = db
        .prepare(`SELECT * FROM run_pauses WHERE run_id = ? AND ${ACTIVE}`)
        .get(input.runId) as Row | undefined;
      if (run.status === 'Cancelled') {
        const cancelledPause = db
          .prepare('SELECT 1 FROM run_pauses WHERE run_id = ? AND cancelled_at IS NOT NULL')
          .get(input.runId);
        if (cancelledPause) return { outcome: 'noop', run };
      }
      if (run.status !== 'Paused' || !active)
        return { outcome: 'rejected', reason: 'not-paused', run };

      db.prepare(`UPDATE run_pauses SET cancelled_at = ? WHERE id = ? AND ${ACTIVE}`).run(
        input.at,
        active.id as string,
      );
      const stepRunId = active.breakpoint_step_run_id as string;
      const step = db.prepare('SELECT * FROM step_runs WHERE id = ?').get(stepRunId) as
        Row | undefined;
      db.prepare(
        "UPDATE step_runs SET status = 'Cancelled', finished_at = ? WHERE id = ? AND status = 'Paused'",
      ).run(input.at, stepRunId);
      db.prepare(
        `UPDATE runs SET status = 'Cancelled', cancel_requested_at = ?, finished_at = ?, paused_at = NULL
         WHERE id = ? AND status = 'Paused'`,
      ).run(input.at, input.at, input.runId);

      events.publishSync({
        type: 'step.status',
        runId: input.runId,
        timestamp: input.at,
        data: {
          stepRunId,
          nodeId: active.breakpoint_node_id as string,
          attempt: (step?.attempt as number) ?? 1,
          status: 'Cancelled',
        },
      });
      events.publishSync({
        type: 'run.step.updated',
        runId: input.runId,
        timestamp: input.at,
        data: {
          stepRunId,
          nodeId: active.breakpoint_node_id as string,
          attempt: (step?.attempt as number) ?? 1,
          status: 'Cancelled',
        },
      });
      events.publishSync({
        type: 'run.status',
        runId: input.runId,
        timestamp: input.at,
        data: { status: 'Cancelled' },
      });
      events.publishSync({
        type: 'run.cancelled',
        runId: input.runId,
        timestamp: input.at,
        data: { cancelledAt: input.at, whilePaused: true },
      });
      if (input.audit) audit.appendSync(input.audit);

      return {
        outcome: 'applied',
        pause: rowToRunPause(
          db.prepare('SELECT * FROM run_pauses WHERE id = ?').get(active.id as string) as Row,
        ),
        run: rowToRun(db.prepare('SELECT * FROM runs WHERE id = ?').get(input.runId) as Row),
      };
    });
  }

  async listCompletedSteps(runId: string): Promise<PausedStepSummary[]> {
    const rows = this.#options.db
      .prepare(
        "SELECT * FROM step_runs WHERE run_id = ? AND status IN ('Succeeded', 'Skipped') ORDER BY rowid",
      )
      .all(runId) as Row[];
    return rows.map((row) => {
      const step = rowToStepRun(row);
      const summary: PausedStepSummary = {
        id: step.id,
        nodeId: step.nodeId,
        attempt: step.attempt,
        status: step.status,
      };
      if (step.outputPreview !== undefined) summary.outputPreview = step.outputPreview;
      if (step.startedAt) summary.startedAt = step.startedAt;
      if (step.finishedAt) summary.finishedAt = step.finishedAt;
      if (step.durationMs !== undefined) summary.durationMs = step.durationMs;
      return summary;
    });
  }
}
