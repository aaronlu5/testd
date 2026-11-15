import type {
  ErrorInfo,
  SuiteRun,
  SuiteRunCounts,
  SuiteRunItem,
  SuiteRunItemStatus,
  SuiteRunSnapshots,
  SuiteRunStatus,
} from '@test-platform/contracts';
import {
  availableDispatchSlots,
  countSuiteItems,
  decideSuiteItemTransition,
  decideSuiteRunTransition,
  isTerminalSuiteItemStatus,
  isTerminalSuiteRunStatus,
  type NewSuiteRun,
  type SuiteItemUpdate,
  type SuiteRunFilter,
  type SuiteRunRepository,
  type SuiteRunTransition,
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

export const rowToSuiteRun = (row: Row): SuiteRun => {
  const run: SuiteRun = {
    id: row.id as string,
    status: row.status as SuiteRunStatus,
    environmentId: row.environment_id as string,
    suite: { id: row.suite_id as string, version: row.suite_version as number },
    requestedBy: row.requested_by as string,
    requestedAt: row.requested_at as string,
    maxConcurrency: row.max_concurrency as number,
    variableOverrides: fromJson<SuiteRun['variableOverrides']>(row.variable_overrides) ?? {},
    snapshots: fromJson<SuiteRunSnapshots>(row.snapshots) as SuiteRunSnapshots,
  };
  if (text(row.started_at)) run.startedAt = row.started_at as string;
  if (text(row.finished_at)) run.finishedAt = row.finished_at as string;
  if (text(row.cancel_requested_at)) run.cancelRequestedAt = row.cancel_requested_at as string;
  if (text(row.rerun_of_suite_run_id)) run.rerunOfSuiteRunId = row.rerun_of_suite_run_id as string;
  const error = fromJson<ErrorInfo>(row.error);
  if (error !== undefined) run.error = error;
  return run;
};

export const rowToSuiteItem = (row: Row): SuiteRunItem => {
  const item: SuiteRunItem = {
    id: row.id as string,
    suiteRunId: row.suite_run_id as string,
    position: row.position as number,
    test: { id: row.test_id as string, version: row.test_version as number },
    testData: { id: row.data_set_id as string, version: row.data_set_version as number },
    status: row.status as SuiteRunItemStatus,
  };
  if (text(row.run_id)) item.runId = row.run_id as string;
  if (text(row.dispatched_at)) item.dispatchedAt = row.dispatched_at as string;
  if (text(row.finished_at)) item.finishedAt = row.finished_at as string;
  return item;
};

/**
 * Suite Run parent/child coordination data. Methods are conditional on the expected status and
 * `claimPendingItems` caps dispatch by the stored concurrency, so a restarted scheduler that
 * re-reads this table can never exceed the limit. Scheduling itself arrives in a later increment.
 */
export class SqliteSuiteRunRepository implements SuiteRunRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async createSuiteRun(input: NewSuiteRun): Promise<void> {
    this.insertSuiteRun(input);
  }

  /** Synchronous so callers can compose it into a larger transaction (for example with a Run). */
  insertSuiteRun({ suiteRun, items }: NewSuiteRun): void {
    transaction(this.#db, () => {
      this.#db
        .prepare(
          `INSERT INTO suite_runs (id, status, environment_id, suite_id, suite_version, requested_by, requested_at,
             started_at, finished_at, cancel_requested_at, rerun_of_suite_run_id, max_concurrency,
             variable_overrides, snapshots, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ...bind([
            suiteRun.id,
            suiteRun.status,
            suiteRun.environmentId,
            suiteRun.suite.id,
            suiteRun.suite.version,
            suiteRun.requestedBy,
            suiteRun.requestedAt,
            suiteRun.startedAt,
            suiteRun.finishedAt,
            suiteRun.cancelRequestedAt,
            suiteRun.rerunOfSuiteRunId,
            suiteRun.maxConcurrency,
            toJson(suiteRun.variableOverrides ?? {}),
            toJson(suiteRun.snapshots),
            toJson(suiteRun.error),
          ]),
        );
      const insert = this.#db.prepare(
        `INSERT INTO suite_run_items (id, suite_run_id, position, test_id, test_version, data_set_id,
           data_set_version, run_id, status, dispatched_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of items) {
        insert.run(
          ...bind([
            item.id,
            item.suiteRunId,
            item.position,
            item.test.id,
            item.test.version,
            item.testData.id,
            item.testData.version,
            item.runId,
            item.status,
            item.dispatchedAt,
            item.finishedAt,
          ]),
        );
      }
    });
  }

  async getSuiteRun(id: string): Promise<SuiteRun | undefined> {
    return this.getSuiteRunSync(id);
  }

  getSuiteRunSync(id: string): SuiteRun | undefined {
    const row = this.#db.prepare('SELECT * FROM suite_runs WHERE id = ?').get(id) as
      Row | undefined;
    return row ? rowToSuiteRun(row) : undefined;
  }

  async listSuiteRuns(filter: SuiteRunFilter = {}): Promise<SuiteRun[]> {
    const params: SqlValue[] = [];
    let where = '';
    if (filter.status) {
      where = 'WHERE status = ?';
      params.push(filter.status);
    }
    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
    const offset = Math.max(Math.trunc(filter.offset ?? 0), 0);
    const rows = this.#db
      .prepare(`SELECT * FROM suite_runs ${where} ORDER BY requested_at DESC, id LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Row[];
    return rows.map(rowToSuiteRun);
  }

  async listActiveSuiteRuns(): Promise<SuiteRun[]> {
    const rows = this.#db
      .prepare(
        `SELECT * FROM suite_runs WHERE status NOT IN ('Succeeded', 'Failed', 'Cancelled')
         ORDER BY requested_at, id`,
      )
      .all() as Row[];
    return rows.map(rowToSuiteRun);
  }

  async listItems(suiteRunId: string): Promise<SuiteRunItem[]> {
    return this.listItemsSync(suiteRunId);
  }

  listItemsSync(suiteRunId: string): SuiteRunItem[] {
    const rows = this.#db
      .prepare('SELECT * FROM suite_run_items WHERE suite_run_id = ? ORDER BY position')
      .all(suiteRunId) as Row[];
    return rows.map(rowToSuiteItem);
  }

  async counts(suiteRunId: string): Promise<SuiteRunCounts> {
    return this.countsSync(suiteRunId);
  }

  countsSync(suiteRunId: string): SuiteRunCounts {
    const rows = this.#db
      .prepare('SELECT status FROM suite_run_items WHERE suite_run_id = ?')
      .all(suiteRunId) as Row[];
    return countSuiteItems(rows.map((row) => row.status as SuiteRunItemStatus));
  }

  async transitionSuiteRun(
    id: string,
    transition: SuiteRunTransition,
  ): Promise<TransitionResult<SuiteRun>> {
    return this.transitionSuiteRunSync(id, transition);
  }

  transitionSuiteRunSync(id: string, transition: SuiteRunTransition): TransitionResult<SuiteRun> {
    return transaction(this.#db, () => {
      const row = this.#db.prepare('SELECT * FROM suite_runs WHERE id = ?').get(id) as
        Row | undefined;
      if (!row) return { outcome: 'rejected' };
      const current = rowToSuiteRun(row);

      const decision = decideSuiteRunTransition(current.status, transition.to);
      if (decision === 'noop') return { outcome: 'noop', current };
      const allowedFrom = Array.isArray(transition.from) ? transition.from : [transition.from];
      if (decision === 'reject' || !allowedFrom.includes(current.status))
        return { outcome: 'rejected', current };

      this.#db
        .prepare(
          `UPDATE suite_runs SET status = ?,
             started_at = CASE WHEN ? = 'Running' AND started_at IS NULL THEN ? ELSE started_at END,
             cancel_requested_at = CASE WHEN ? IN ('Cancelling', 'Cancelled') AND cancel_requested_at IS NULL
               THEN ? ELSE cancel_requested_at END,
             finished_at = CASE WHEN ? THEN ? ELSE finished_at END,
             error = COALESCE(?, error)
           WHERE id = ? AND status = ?`,
        )
        .run(
          transition.to,
          transition.to,
          transition.at,
          transition.to,
          transition.at,
          isTerminalSuiteRunStatus(transition.to) ? 1 : 0,
          transition.at,
          transition.error ? JSON.stringify(transition.error) : null,
          id,
          current.status,
        );
      return {
        outcome: 'applied',
        current: rowToSuiteRun(
          this.#db.prepare('SELECT * FROM suite_runs WHERE id = ?').get(id) as Row,
        ),
      };
    });
  }

  async claimPendingItems(suiteRunId: string, at: string): Promise<SuiteRunItem[]> {
    return this.claimPendingItemsSync(suiteRunId, at);
  }

  /** Synchronous so dispatch can claim and create child Runs in one transaction. */
  claimPendingItemsSync(suiteRunId: string, at: string): SuiteRunItem[] {
    return transaction(this.#db, () => {
      const row = this.#db.prepare('SELECT * FROM suite_runs WHERE id = ?').get(suiteRunId) as
        Row | undefined;
      if (!row) return [];
      const suiteRun = rowToSuiteRun(row);
      if (isTerminalSuiteRunStatus(suiteRun.status) || suiteRun.status === 'Cancelling') return [];
      if (suiteRun.cancelRequestedAt) return [];

      const slots = availableDispatchSlots(this.countsSync(suiteRunId), suiteRun.maxConcurrency);
      if (slots === 0) return [];
      const pending = this.#db
        .prepare(
          `SELECT * FROM suite_run_items WHERE suite_run_id = ? AND status = 'Pending'
           ORDER BY position LIMIT ?`,
        )
        .all(suiteRunId, slots) as Row[];
      const claim = this.#db.prepare(
        `UPDATE suite_run_items SET status = 'Queued', dispatched_at = ? WHERE id = ? AND status = 'Pending'`,
      );
      for (const item of pending) claim.run(at, item.id as string);
      return pending.map((item) =>
        rowToSuiteItem(
          this.#db
            .prepare('SELECT * FROM suite_run_items WHERE id = ?')
            .get(item.id as string) as Row,
        ),
      );
    });
  }

  async updateItem(
    itemId: string,
    update: SuiteItemUpdate,
    expectedStatus?: SuiteRunItemStatus | readonly SuiteRunItemStatus[],
  ): Promise<TransitionResult<SuiteRunItem>> {
    return this.updateItemSync(itemId, update, expectedStatus);
  }

  updateItemSync(
    itemId: string,
    update: SuiteItemUpdate,
    expectedStatus?: SuiteRunItemStatus | readonly SuiteRunItemStatus[],
  ): TransitionResult<SuiteRunItem> {
    return transaction(this.#db, () => {
      const row = this.#db.prepare('SELECT * FROM suite_run_items WHERE id = ?').get(itemId) as
        Row | undefined;
      if (!row) return { outcome: 'rejected' };
      const current = rowToSuiteItem(row);

      if (expectedStatus !== undefined) {
        const allowed = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
        if (!allowed.includes(current.status)) return { outcome: 'rejected', current };
      }
      const decision = decideSuiteItemTransition(current.status, update.status);
      if (decision === 'reject') return { outcome: 'rejected', current };
      if (decision === 'noop' && isTerminalSuiteItemStatus(current.status))
        return { outcome: 'noop', current };

      this.#db
        .prepare(
          `UPDATE suite_run_items SET status = ?, run_id = COALESCE(run_id, ?),
             dispatched_at = CASE WHEN dispatched_at IS NULL AND ? <> 'Pending' THEN ? ELSE dispatched_at END,
             finished_at = CASE WHEN ? THEN ? ELSE finished_at END
           WHERE id = ?`,
        )
        .run(
          update.status,
          update.runId ?? null,
          update.status,
          update.at,
          isTerminalSuiteItemStatus(update.status) ? 1 : 0,
          update.at,
          itemId,
        );
      return {
        outcome: 'applied',
        current: rowToSuiteItem(
          this.#db.prepare('SELECT * FROM suite_run_items WHERE id = ?').get(itemId) as Row,
        ),
      };
    });
  }

  async findItemByRunId(runId: string): Promise<SuiteRunItem | undefined> {
    const row = this.#db.prepare('SELECT * FROM suite_run_items WHERE run_id = ?').get(runId) as
      Row | undefined;
    return row ? rowToSuiteItem(row) : undefined;
  }
}
