import type {
  SuiteRun,
  SuiteRunItem,
  SuiteRunItemStatus,
  SuiteRunStatus,
} from '@test-platform/contracts';
import {
  availableDispatchSlots,
  buildChildRun,
  countSuiteItems,
  deriveSuiteRunStatus,
  isTerminalSuiteItemStatus,
  isTerminalSuiteRunStatus,
  systemClock,
  type AuditEvent,
  type Clock,
  type NewSuiteRun,
  type TransitionResult,
} from '@test-platform/core';
import { newId } from '../ids.js';
import type { SqliteAuditLog, SqliteRunEvents } from './audit-and-events.js';
import { transaction, type Database } from './database.js';
import type { SqliteRunCommands } from './run-commands.js';
import type { SqliteRunRepository } from './run-repository.js';
import type { SqliteSuiteRunRepository } from './suite-run-repository.js';

export type SqliteSuiteRunCommandsOptions = {
  db: Database;
  suiteRuns: SqliteSuiteRunRepository;
  runs: SqliteRunRepository;
  runCommands: SqliteRunCommands;
  events: SqliteRunEvents;
  audit: SqliteAuditLog;
  clock?: Clock;
  /** Identifier source for child Runs; tests inject a deterministic one. */
  newId?: () => string;
};

export type AdvanceResult = {
  suiteRun: SuiteRun;
  /** Child Runs created by this call. */
  dispatched: SuiteRunItem[];
  changed: boolean;
};

/** Child Run statuses map one-to-one onto item statuses. */
const itemStatusOf = (status: string): SuiteRunItemStatus | undefined =>
  (['Queued', 'Running', 'Paused', 'Cancelling', 'Succeeded', 'Failed', 'Cancelled'] as const).find(
    (candidate) => candidate === status,
  );

/**
 * Suite Run writes. Every method is one IMMEDIATE transaction that re-reads the parent, its items
 * and the child Runs, so a restarted or concurrent scheduler can neither dispatch more children
 * than `maxConcurrency` nor create a child twice: a claimed item and its child Run are written
 * together or not at all.
 */
export class SqliteSuiteRunCommands {
  readonly #o: SqliteSuiteRunCommandsOptions;
  readonly #clock: Clock;
  readonly #newId: () => string;

  constructor(options: SqliteSuiteRunCommandsOptions) {
    this.#o = options;
    this.#clock = options.clock ?? systemClock;
    this.#newId = options.newId ?? newId;
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }

  /** Stores the parent and its Pending children; dispatch happens on the next `advance`. */
  async submit(plan: NewSuiteRun, audit?: AuditEvent): Promise<SuiteRun> {
    const { db, suiteRuns, audit: log } = this.#o;
    return transaction(db, () => {
      suiteRuns.insertSuiteRun(plan);
      this.#publish(plan.suiteRun);
      if (audit) log.appendSync(audit);
      return plan.suiteRun;
    });
  }

  /**
   * Cancels undispatched, active and paused children. Pending items become Skipped, Queued and
   * Paused children are cancelled directly, Running children are asked to stop. The parent
   * reaches Cancelled once no child is active.
   */
  async requestCancel(input: {
    suiteRunId: string;
    at?: string;
    audit?: AuditEvent;
  }): Promise<TransitionResult<SuiteRun>> {
    const { db, suiteRuns, audit: log } = this.#o;
    return transaction(db, () => {
      const at = input.at ?? this.#now();
      const current = suiteRuns.getSuiteRunSync(input.suiteRunId);
      if (!current) return { outcome: 'rejected' };
      if (current.status === 'Cancelling' || current.status === 'Cancelled')
        return { outcome: 'noop', current };
      if (isTerminalSuiteRunStatus(current.status)) return { outcome: 'rejected', current };

      if (current.status === 'Queued') {
        // Nothing was dispatched yet: skip every child and finish immediately.
        for (const item of suiteRuns.listItemsSync(input.suiteRunId))
          suiteRuns.updateItemSync(item.id, { status: 'Skipped', at });
        const cancelled = suiteRuns.transitionSuiteRunSync(input.suiteRunId, {
          from: 'Queued',
          to: 'Cancelled',
          at,
        });
        if (cancelled.outcome === 'applied' && cancelled.current) {
          this.#publish(cancelled.current, at);
          if (input.audit) log.appendSync(input.audit);
        }
        return cancelled;
      }

      const moved = suiteRuns.transitionSuiteRunSync(input.suiteRunId, {
        from: current.status,
        to: 'Cancelling',
        at,
      });
      if (moved.outcome !== 'applied') return moved;
      if (input.audit) log.appendSync(input.audit);
      const advanced = this.#advance(input.suiteRunId, at);
      return { outcome: 'applied', current: advanced.suiteRun };
    });
  }

  /** One scheduling pass for one Suite Run: sync children, cancel or dispatch, update the parent. */
  async advance(suiteRunId: string): Promise<AdvanceResult | undefined> {
    return transaction(this.#o.db, () => this.#advance(suiteRunId, this.#now()));
  }

  #advance(suiteRunId: string, at: string): AdvanceResult {
    const { suiteRuns, runs, runCommands } = this.#o;
    const start = suiteRuns.getSuiteRunSync(suiteRunId);
    if (!start) throw new Error(`Suite Run ${suiteRunId} does not exist.`);
    const dispatched: SuiteRunItem[] = [];
    if (isTerminalSuiteRunStatus(start.status))
      return { suiteRun: start, dispatched, changed: false };

    let changed = false;
    const mirror = (): void => {
      for (const item of suiteRuns.listItemsSync(suiteRunId)) {
        if (!item.runId || isTerminalSuiteItemStatus(item.status)) continue;
        const child = runs.getRunSync(item.runId);
        const desired = child ? itemStatusOf(child.status) : undefined;
        if (!desired || desired === item.status) continue;
        if (suiteRuns.updateItemSync(item.id, { status: desired, at }).outcome === 'applied')
          changed = true;
      }
    };

    mirror();
    let suiteRun = suiteRuns.getSuiteRunSync(suiteRunId) as SuiteRun;

    if (suiteRun.cancelRequestedAt || suiteRun.status === 'Cancelling') {
      for (const item of suiteRuns.listItemsSync(suiteRunId)) {
        if (item.status === 'Pending') {
          suiteRuns.updateItemSync(item.id, { status: 'Skipped', at });
          changed = true;
        } else if (item.runId && !isTerminalSuiteItemStatus(item.status)) {
          const result = runCommands.requestCancelSync({ runId: item.runId, at });
          if (result.outcome === 'applied') changed = true;
        }
      }
      mirror();
    } else {
      const counts = countSuiteItems(
        suiteRuns.listItemsSync(suiteRunId).map((item) => item.status),
      );
      if (availableDispatchSlots(counts, suiteRun.maxConcurrency) > 0) {
        if (suiteRun.status === 'Queued') {
          suiteRuns.transitionSuiteRunSync(suiteRunId, { from: 'Queued', to: 'Running', at });
        }
        for (const item of suiteRuns.claimPendingItemsSync(suiteRunId, at)) {
          const child = buildChildRun(suiteRun, item, { id: this.#newId(), at });
          runCommands.submitSync({ run: child });
          suiteRuns.updateItemSync(item.id, { status: 'Queued', runId: child.id, at }, 'Queued');
          dispatched.push({ ...item, status: 'Queued', runId: child.id, dispatchedAt: at });
          changed = true;
        }
        suiteRun = suiteRuns.getSuiteRunSync(suiteRunId) as SuiteRun;
      }
    }

    const counts = countSuiteItems(suiteRuns.listItemsSync(suiteRunId).map((item) => item.status));
    const derived: SuiteRunStatus = deriveSuiteRunStatus(counts, {
      cancelRequested: Boolean(suiteRun.cancelRequestedAt) || suiteRun.status === 'Cancelling',
      started: suiteRun.status !== 'Queued',
    });
    if (derived !== suiteRun.status && derived !== 'Queued') {
      const moved = suiteRuns.transitionSuiteRunSync(suiteRunId, {
        from: suiteRun.status,
        to: derived,
        at,
      });
      if (moved.outcome === 'applied') changed = true;
    }

    const latest = suiteRuns.getSuiteRunSync(suiteRunId) as SuiteRun;
    if (changed) this.#publish(latest, at);
    return { suiteRun: latest, dispatched, changed };
  }

  #publish(suiteRun: SuiteRun, at: string = this.#now()): void {
    const { suiteRuns, events } = this.#o;
    events.publishSuiteSync({
      type: 'suiteRun.updated',
      suiteRunId: suiteRun.id,
      timestamp: at,
      data: {
        status: suiteRun.status,
        counts: countSuiteItems(suiteRuns.listItemsSync(suiteRun.id).map((item) => item.status)),
      },
    });
  }
}
