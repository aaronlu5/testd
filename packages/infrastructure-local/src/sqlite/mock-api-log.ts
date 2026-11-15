import type { MockApiRequestPage, MockApiRequestRecord } from '@test-platform/contracts';
import { systemClock, type Clock, type Redactor } from '@test-platform/core';
import { fromJson, toJson, type Database, type Row } from './database.js';

export const MOCK_API_LOG_MAX_RECORDS = 500;
const BODY_PREVIEW_CHARS = 4_096;
const DEFAULT_PAGE = 100;
const MAX_PAGE = 500;

export type MockApiRequestInput = {
  method: string;
  path: string;
  query: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  requestBodyTruncated?: boolean;
  status: number;
  matched: boolean;
  setupId?: string;
  setupName?: string;
  ruleNumber?: number;
  ruleName?: string;
  responseBody?: string;
};

export type MockApiWorkerState = {
  listening: boolean;
  host?: string;
  port?: number;
  startedAt?: string;
  heartbeatAt: string;
  activeRuns: number;
  error?: string;
};

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;
const whole = (value: unknown): number | undefined =>
  typeof value === 'number' ? value : undefined;

const rowToRecord = (row: Row): MockApiRequestRecord => {
  const record: MockApiRequestRecord = {
    id: Number(row.id),
    at: row.at as string,
    method: row.method as string,
    path: row.path as string,
    query: (row.query as string) ?? '',
    requestHeaders: fromJson<Record<string, string>>(row.request_headers) ?? {},
    requestBodyTruncated: Number(row.request_body_truncated) === 1,
    status: Number(row.status),
    matched: Number(row.matched) === 1,
  };
  if (text(row.request_body)) record.requestBody = row.request_body as string;
  if (text(row.setup_id)) record.setupId = row.setup_id as string;
  if (text(row.setup_name)) record.setupName = row.setup_name as string;
  if (whole(row.rule_number) !== undefined) record.ruleNumber = row.rule_number as number;
  if (text(row.rule_name)) record.ruleName = row.rule_name as string;
  if (text(row.response_body)) record.responseBody = row.response_body as string;
  return record;
};

/**
 * The Mock API server's request log and liveness record. The worker is the only writer of
 * requests and state; any process may read. Text is masked for secrets and capped on the way in.
 */
export class SqliteMockApiLog {
  readonly #db: Database;
  readonly #redactor: Redactor;
  readonly #clock: Clock;
  readonly #maxRecords: number;

  constructor(options: { db: Database; redactor: Redactor; clock?: Clock; maxRecords?: number }) {
    this.#db = options.db;
    this.#redactor = options.redactor;
    this.#clock = options.clock ?? systemClock;
    this.#maxRecords = options.maxRecords ?? MOCK_API_LOG_MAX_RECORDS;
  }

  get maxRecords(): number {
    return this.#maxRecords;
  }

  #mask(value: string | undefined): { text?: string; truncated: boolean } {
    if (value === undefined || value === '') return { truncated: false };
    const clipped = value.length > BODY_PREVIEW_CHARS;
    const preview = clipped ? value.slice(0, BODY_PREVIEW_CHARS) : value;
    return { text: this.#redactor.redactText(preview), truncated: clipped };
  }

  /** Stores one request, drops the oldest beyond the cap, and returns its id. */
  record(input: MockApiRequestInput): number {
    const request = this.#mask(input.requestBody);
    const response = this.#mask(input.responseBody);
    const headers = Object.fromEntries(
      Object.entries(input.requestHeaders).map(([name, value]) => [
        name,
        this.#redactor.redactText(value).slice(0, 300),
      ]),
    );
    const result = this.#db
      .prepare(
        `INSERT INTO mock_api_requests (at, method, path, query, request_headers, request_body,
           request_body_truncated, status, matched, setup_id, setup_name, rule_number, rule_name,
           response_body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.#clock.now().toISOString(),
        input.method,
        this.#redactor.redactText(input.path).slice(0, 2_048),
        this.#redactor.redactText(input.query).slice(0, 2_048),
        toJson(headers) ?? '{}',
        request.text ?? null,
        input.requestBodyTruncated || request.truncated ? 1 : 0,
        input.status,
        input.matched ? 1 : 0,
        input.setupId ?? null,
        input.setupName ?? null,
        input.ruleNumber ?? null,
        input.ruleName ?? null,
        response.text ?? null,
      );
    const id = Number(result.lastInsertRowid);
    this.#db.prepare('DELETE FROM mock_api_requests WHERE id <= ?').run(id - this.#maxRecords);
    return id;
  }

  /** Newest first. */
  list(options: { limit?: number } = {}): MockApiRequestPage {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_PAGE), 1), MAX_PAGE);
    const rows = this.#db
      .prepare('SELECT * FROM mock_api_requests ORDER BY id DESC LIMIT ?')
      .all(limit);
    const stats = this.#db
      .prepare('SELECT COUNT(*) AS total, COALESCE(MAX(id), 0) AS last FROM mock_api_requests')
      .get() as Row;
    return {
      items: rows.map(rowToRecord),
      total: Number(stats.total),
      lastId: Number(stats.last),
      maxRecords: this.#maxRecords,
    };
  }

  clear(): number {
    return this.#db.prepare('DELETE FROM mock_api_requests').run().changes as number;
  }

  /** Records that the worker is serving (or failed to serve) the Mock API server. */
  heartbeat(state: Omit<MockApiWorkerState, 'heartbeatAt'>): void {
    this.#db
      .prepare(
        `INSERT INTO mock_api_state (id, listening, host, port, started_at, heartbeat_at, active_runs, error)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET listening = excluded.listening, host = excluded.host,
           port = excluded.port, started_at = excluded.started_at,
           heartbeat_at = excluded.heartbeat_at, active_runs = excluded.active_runs,
           error = excluded.error`,
      )
      .run(
        state.listening ? 1 : 0,
        state.host ?? null,
        state.port ?? null,
        state.startedAt ?? null,
        this.#clock.now().toISOString(),
        state.activeRuns,
        state.error ?? null,
      );
  }

  state(): MockApiWorkerState | undefined {
    const row = this.#db.prepare('SELECT * FROM mock_api_state WHERE id = 1').get() as
      Row | undefined;
    if (!row) return undefined;
    return {
      listening: Number(row.listening) === 1,
      ...(text(row.host) ? { host: row.host as string } : {}),
      ...(whole(row.port) !== undefined ? { port: row.port as number } : {}),
      ...(text(row.started_at) ? { startedAt: row.started_at as string } : {}),
      heartbeatAt: row.heartbeat_at as string,
      activeRuns: Number(row.active_runs),
      ...(text(row.error) ? { error: row.error as string } : {}),
    };
  }
}
