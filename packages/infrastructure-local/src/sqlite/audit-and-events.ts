import type { RunEvent, SuiteRunUpdatedEvent } from '@test-platform/contracts';
import {
  systemClock,
  redactValue,
  type AuditEvent,
  type AuditLog,
  type Clock,
  type EventPublisher,
  type RunEventSource,
} from '@test-platform/core';
import { toJson, type Database, type Row } from './database.js';

/** Appends audit events; metadata is masked again here as a last line of defence. */
export class SqliteAuditLog implements AuditLog {
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #secretValues: () => Iterable<string>;

  constructor(
    db: Database,
    clock: Clock = systemClock,
    secretValues: () => Iterable<string> = () => [],
  ) {
    this.#db = db;
    this.#clock = clock;
    this.#secretValues = secretValues;
  }

  async append(event: AuditEvent): Promise<void> {
    this.appendSync(event);
  }

  /** Synchronous so callers can compose it into a larger transaction. */
  appendSync(event: AuditEvent): void {
    const metadata = redactValue(event.metadata ?? {}, { secretValues: this.#secretValues() });
    this.#db
      .prepare(
        'INSERT INTO audit_events (actor, action, entity_type, entity_id, at, metadata) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        event.actor,
        event.action,
        event.entityType,
        event.entityId,
        event.at ?? this.#clock.now().toISOString(),
        toJson(metadata) as string,
      );
  }
}

/**
 * Database-backed run events so the worker process can feed the API's SSE stream.
 * `seq` is the autoincrement key and doubles as the SSE `Last-Event-ID`.
 */
export class SqliteRunEvents implements EventPublisher, RunEventSource {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async publish(event: RunEvent): Promise<void> {
    this.publishSync(event);
  }

  /** Synchronous so callers can compose it into a larger transaction. */
  publishSync(event: RunEvent): void {
    this.#db
      .prepare('INSERT INTO run_events (run_id, type, at, payload) VALUES (?, ?, ?, ?)')
      .run(event.runId, event.type, event.timestamp, JSON.stringify(event.data));
  }

  async listSince(runId: string, afterSeq = 0, limit = 200): Promise<RunEvent[]> {
    const rows = this.#db
      .prepare('SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(runId, afterSeq, Math.min(Math.max(Math.trunc(limit), 1), 1000)) as Row[];
    return rows.map(
      (row) =>
        ({
          seq: row.seq as number,
          type: row.type,
          runId: row.run_id as string,
          timestamp: row.at as string,
          data: JSON.parse(row.payload as string),
        }) as RunEvent,
    );
  }

  async lastSeq(runId: string): Promise<number> {
    const row = this.#db
      .prepare('SELECT MAX(seq) AS seq FROM run_events WHERE run_id = ?')
      .get(runId) as Row;
    return Number(row.seq ?? 0);
  }

  /** Suite Run progress shares the feed table, keyed by the Suite Run id. */
  publishSuiteSync(event: SuiteRunUpdatedEvent): void {
    this.#db
      .prepare('INSERT INTO run_events (run_id, type, at, payload) VALUES (?, ?, ?, ?)')
      .run(event.suiteRunId, event.type, event.timestamp, JSON.stringify(event.data));
  }

  async listSuiteSince(
    suiteRunId: string,
    afterSeq = 0,
    limit = 200,
  ): Promise<SuiteRunUpdatedEvent[]> {
    const rows = this.#db
      .prepare('SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(suiteRunId, afterSeq, Math.min(Math.max(Math.trunc(limit), 1), 1000)) as Row[];
    return rows.map(
      (row) =>
        ({
          seq: row.seq as number,
          type: row.type,
          suiteRunId: row.run_id as string,
          timestamp: row.at as string,
          data: JSON.parse(row.payload as string),
        }) as SuiteRunUpdatedEvent,
    );
  }
}
