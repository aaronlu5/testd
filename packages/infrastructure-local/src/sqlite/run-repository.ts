import type {
  ErrorInfo,
  JsonValue,
  Run,
  StepLogEntry,
  ArtifactReference,
  StepRun,
  StepRunStatus,
} from '@test-platform/contracts';
import {
  decideRunTransition,
  decideStepRunTransition,
  isTerminalRunStatus,
  isTerminalStepRunStatus,
  type RunFilter,
  type RunRepository,
  type RunTransition,
  type StepRunPatch,
  type TransitionResult,
} from '@test-platform/core';
import {
  bind,
  fromJson,
  toJson,
  transaction,
  type Database,
  type Row,
  type SqlValue,
} from './database.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);

export const rowToRun = (row: Row): Run => {
  const run: Run = {
    id: row.id as string,
    kind: row.kind as Run['kind'],
    status: row.status as Run['status'],
    environmentId: row.environment_id as string,
    requestedBy: row.requested_by as string,
    requestedAt: row.requested_at as string,
    variableOverrides: fromJson<Run['variableOverrides']>(row.variable_overrides) ?? {},
    snapshots: fromJson<Run['snapshots']>(row.snapshots) as Run['snapshots'],
  };
  const optional: [keyof Run, unknown][] = [
    ['startedAt', text(row.started_at)],
    ['finishedAt', text(row.finished_at)],
    ['cancelRequestedAt', text(row.cancel_requested_at)],
    ['pausedAt', text(row.paused_at)],
    ['parentRunId', text(row.parent_run_id)],
    ['rerunOfRunId', text(row.rerun_of_run_id)],
    ['runNumber', num(row.run_number)],
    ['error', fromJson<ErrorInfo>(row.error)],
  ];
  for (const [key, value] of optional)
    if (value !== undefined) (run as Record<string, unknown>)[key] = value;
  // Absent means generation 0, so Runs created before Phase 2 keep their exact shape.
  if (num(row.continuation_generation))
    run.continuationGeneration = row.continuation_generation as number;
  if (text(row.test_id))
    run.test = { id: row.test_id as string, version: num(row.test_version) as number };
  if (text(row.data_set_id))
    run.testData = { id: row.data_set_id as string, version: num(row.data_set_version) as number };
  if (text(row.suite_id))
    run.suite = { id: row.suite_id as string, version: num(row.suite_version) as number };
  return run;
};

export const rowToStepRun = (row: Row): StepRun => {
  const step: StepRun = {
    id: row.id as string,
    runId: row.run_id as string,
    nodeId: row.node_id as string,
    attempt: row.attempt as number,
    status: row.status as StepRunStatus,
    logs: fromJson<StepLogEntry[]>(row.logs) ?? [],
    artifacts: fromJson<ArtifactReference[]>(row.artifacts) ?? [],
  };
  const resolvedInput = fromJson<JsonValue>(row.resolved_input);
  const outputPreview = fromJson<JsonValue>(row.output_preview);
  const error = fromJson<ErrorInfo>(row.error);
  if (resolvedInput !== undefined) step.resolvedInput = resolvedInput;
  if (outputPreview !== undefined) step.outputPreview = outputPreview;
  if (error !== undefined) step.error = error;
  if (text(row.started_at)) step.startedAt = row.started_at as string;
  if (text(row.finished_at)) step.finishedAt = row.finished_at as string;
  if (num(row.duration_ms) !== undefined) step.durationMs = row.duration_ms as number;
  return step;
};

export class SqliteRunRepository implements RunRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async createRun(run: Run): Promise<void> {
    this.insertRun(run);
  }

  /** Synchronous so callers can compose it into a larger transaction. */
  insertRun(run: Run): void {
    this.#db
      .prepare(
        `INSERT INTO runs (id, kind, status, environment_id, requested_by, requested_at, started_at, finished_at,
           cancel_requested_at, parent_run_id, rerun_of_run_id, test_id, test_version, data_set_id, data_set_version,
           suite_id, suite_version, variable_overrides, snapshots, error, continuation_generation, paused_at,
           run_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           CASE WHEN ? IS NULL THEN NULL
                ELSE (SELECT COALESCE(MAX(run_number), 0) + 1 FROM runs WHERE test_id = ?) END)`,
      )
      .run(
        ...bind([
          run.id,
          run.kind,
          run.status,
          run.environmentId,
          run.requestedBy,
          run.requestedAt,
          run.startedAt,
          run.finishedAt,
          run.cancelRequestedAt,
          run.parentRunId,
          run.rerunOfRunId,
          run.test?.id,
          run.test?.version,
          run.testData?.id,
          run.testData?.version,
          run.suite?.id,
          run.suite?.version,
          toJson(run.variableOverrides ?? {}),
          toJson(run.snapshots),
          toJson(run.error),
          run.continuationGeneration ?? 0,
          run.pausedAt,
          run.test?.id,
          run.test?.id,
        ]),
      );
  }

  async getRun(id: string): Promise<Run | undefined> {
    return this.getRunSync(id);
  }

  /** Synchronous so callers can compose it into a larger transaction. */
  getRunSync(id: string): Run | undefined {
    const row = this.#db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToRun(row) : undefined;
  }

  async listRuns(filter: RunFilter = {}): Promise<Run[]> {
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    const add = (column: string, value: SqlValue | undefined): void => {
      if (value === undefined) return;
      clauses.push(`${column} = ?`);
      params.push(value);
    };
    add('status', filter.status);
    add('kind', filter.kind);
    add('test_id', filter.testId);
    add('environment_id', filter.environmentId);
    add('parent_run_id', filter.parentRunId);

    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
    const offset = Math.max(Math.trunc(filter.offset ?? 0), 0);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.#db
      .prepare(`SELECT * FROM runs ${where} ORDER BY requested_at DESC, id LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Row[];
    return rows.map(rowToRun);
  }

  async transitionRun(id: string, transition: RunTransition): Promise<TransitionResult<Run>> {
    return transaction(this.#db, () => {
      const row = this.#db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
      if (!row) return { outcome: 'rejected' };
      const current = rowToRun(row);

      const decision = decideRunTransition(current.status, transition.to);
      if (decision === 'noop') return { outcome: 'noop', current };
      const allowedFrom = Array.isArray(transition.from) ? transition.from : [transition.from];
      if (decision === 'reject' || !allowedFrom.includes(current.status))
        return { outcome: 'rejected', current };

      this.#db
        .prepare(
          `UPDATE runs SET status = ?,
             started_at = CASE WHEN ? = 'Running' AND started_at IS NULL THEN ? ELSE started_at END,
             finished_at = CASE WHEN ? THEN ? ELSE finished_at END,
             error = COALESCE(?, error),
             paused_at = CASE WHEN ? = 'Paused' THEN ? ELSE NULL END
           WHERE id = ? AND status = ?`,
        )
        .run(
          transition.to,
          transition.to,
          transition.at,
          isTerminalRunStatus(transition.to) ? 1 : 0,
          transition.at,
          transition.error ? JSON.stringify(transition.error) : null,
          transition.to,
          transition.at,
          id,
          current.status,
        );
      return {
        outcome: 'applied',
        current: rowToRun(this.#db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row),
      };
    });
  }

  async requestCancel(id: string, at: string): Promise<TransitionResult<Run>> {
    return this.requestCancelSync(id, at);
  }

  /** Synchronous so callers can compose it into a larger transaction. */
  requestCancelSync(id: string, at: string): TransitionResult<Run> {
    return transaction(this.#db, () => {
      const row = this.#db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
      if (!row) return { outcome: 'rejected' };
      const current = rowToRun(row);

      if (current.status === 'Cancelling' || current.status === 'Cancelled')
        return { outcome: 'noop', current };
      if (current.status !== 'Queued' && current.status !== 'Running')
        return { outcome: 'rejected', current };

      const next = current.status === 'Queued' ? 'Cancelled' : 'Cancelling';
      this.#db
        .prepare(
          `UPDATE runs SET status = ?, cancel_requested_at = ?,
             finished_at = CASE WHEN ? = 'Cancelled' THEN ? ELSE finished_at END
           WHERE id = ?`,
        )
        .run(next, at, next, at, id);
      if (next === 'Cancelled') {
        // A resumed Run cancelled before a worker claimed it still has its Breakpoint attempt Paused.
        this.#db
          .prepare(
            "UPDATE step_runs SET status = 'Cancelled', finished_at = ? WHERE run_id = ? AND status = 'Paused'",
          )
          .run(at, id);
      }
      return {
        outcome: 'applied',
        current: rowToRun(this.#db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row),
      };
    });
  }

  async createStepRun(stepRun: StepRun): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO step_runs (id, run_id, node_id, attempt, status, resolved_input, output_preview, error, logs,
           artifacts, started_at, finished_at, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ...bind([
          stepRun.id,
          stepRun.runId,
          stepRun.nodeId,
          stepRun.attempt,
          stepRun.status,
          toJson(stepRun.resolvedInput),
          toJson(stepRun.outputPreview),
          toJson(stepRun.error),
          toJson(stepRun.logs ?? []),
          toJson(stepRun.artifacts ?? []),
          stepRun.startedAt,
          stepRun.finishedAt,
          stepRun.durationMs,
        ]),
      );
  }

  async updateStepRun(
    id: string,
    patch: StepRunPatch,
    expectedStatus?: StepRunStatus | readonly StepRunStatus[],
  ): Promise<TransitionResult<StepRun>> {
    return transaction(this.#db, () => {
      const row = this.#db.prepare('SELECT * FROM step_runs WHERE id = ?').get(id) as
        Row | undefined;
      if (!row) return { outcome: 'rejected' };
      const current = rowToStepRun(row);

      if (expectedStatus !== undefined) {
        const allowed = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
        if (!allowed.includes(current.status)) return { outcome: 'rejected', current };
      }
      if (patch.status !== undefined) {
        const decision = decideStepRunTransition(current.status, patch.status);
        if (decision === 'reject') return { outcome: 'rejected', current };
        if (decision === 'noop' && isTerminalStepRunStatus(current.status))
          return { outcome: 'noop', current };
      } else if (isTerminalStepRunStatus(current.status)) {
        return { outcome: 'rejected', current };
      }

      const columns: [string, SqlValue | undefined][] = [
        ['status', patch.status],
        ['resolved_input', 'resolvedInput' in patch ? toJson(patch.resolvedInput) : undefined],
        ['output_preview', 'outputPreview' in patch ? toJson(patch.outputPreview) : undefined],
        ['error', 'error' in patch ? toJson(patch.error) : undefined],
        ['logs', patch.logs ? toJson(patch.logs) : undefined],
        ['artifacts', patch.artifacts ? toJson(patch.artifacts) : undefined],
        ['started_at', patch.startedAt],
        ['finished_at', patch.finishedAt],
        ['duration_ms', patch.durationMs],
      ];
      const changes = columns.filter(([, value]) => value !== undefined);
      if (changes.length > 0) {
        this.#db
          .prepare(
            `UPDATE step_runs SET ${changes.map(([column]) => `${column} = ?`).join(', ')} WHERE id = ?`,
          )
          .run(...changes.map(([, value]) => value as SqlValue), id);
      }
      return {
        outcome: 'applied',
        current: rowToStepRun(
          this.#db.prepare('SELECT * FROM step_runs WHERE id = ?').get(id) as Row,
        ),
      };
    });
  }

  async getStepRun(id: string): Promise<StepRun | undefined> {
    const row = this.#db.prepare('SELECT * FROM step_runs WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToStepRun(row) : undefined;
  }

  async listStepRuns(runId: string): Promise<StepRun[]> {
    const rows = this.#db
      .prepare('SELECT * FROM step_runs WHERE run_id = ? ORDER BY rowid')
      .all(runId) as Row[];
    return rows.map(rowToStepRun);
  }
}
