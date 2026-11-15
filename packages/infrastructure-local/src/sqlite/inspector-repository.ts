import { randomUUID } from 'node:crypto';
import {
  INSPECTOR_MAX_BODY_BYTES,
  type InspectedMessage,
  type InspectedMessageSummary,
  type InspectorBodyEncoding,
  type InspectorMessagePage,
  type InspectorOrigin,
  type InspectorSummary,
  type InspectorWatch,
  type InspectorWatchInput,
  type InspectorWatchSource,
  type JsonValue,
} from '@test-platform/contracts';
import {
  systemClock,
  type Clock,
  type InspectorSentMessage,
  type InspectorSink,
  type PeekedMessage,
  type Redactor,
} from '@test-platform/core';
import { transaction, fromJson, toJson, type Database, type Row } from './database.js';

export const DEFAULT_INSPECTOR_MAX_MESSAGES = 10_000;
const PREVIEW_CHARS = 160;
const DEFAULT_PAGE = 100;
const MAX_PAGE = 500;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

const rowToWatch = (row: Row): InspectorWatch => {
  const watch: InspectorWatch = {
    id: row.id as string,
    environmentId: row.environment_id as string,
    target: row.target as string,
    entity: row.entity as string,
    source: row.source as InspectorWatchSource,
    createdAt: row.created_at as string,
    createdBy: row.created_by as string,
    receivedCount: Number(row.received_count),
  };
  if (text(row.subscription)) watch.subscription = row.subscription as string;
  if (text(row.last_polled_at)) watch.lastPolledAt = row.last_polled_at as string;
  if (text(row.last_error_code)) watch.lastErrorCode = row.last_error_code as string;
  if (text(row.last_error_at)) watch.lastErrorAt = row.last_error_at as string;
  return watch;
};

const rowToSummary = (row: Row): InspectedMessageSummary => {
  const summary: InspectedMessageSummary = {
    id: row.id as string,
    seq: Number(row.seq),
    origin: row.origin as InspectorOrigin,
    receivedAt: row.received_at as string,
    environmentId: row.environment_id as string,
    target: row.target as string,
    entity: row.entity as string,
    sizeBytes: Number(row.size_bytes),
    preview: row.preview as string,
  };
  for (const [key, column] of [
    ['watchId', 'watch_id'],
    ['subscription', 'subscription'],
    ['messageId', 'message_id'],
    ['subject', 'subject'],
    ['contentType', 'content_type'],
    ['runId', 'run_id'],
  ] as const) {
    const value = text(row[column]);
    if (value) summary[key] = value;
  }
  return summary;
};

/** Body bytes -> a masked, size-capped value for display. */
export const describeBody = (
  bytes: Uint8Array,
  contentType: string | undefined,
  redactor: Redactor,
): { encoding: InspectorBodyEncoding; body: JsonValue; truncated: boolean; preview: string } => {
  if (bytes.byteLength === 0)
    return { encoding: 'empty', body: null, truncated: false, preview: '' };
  const truncated = bytes.byteLength > INSPECTOR_MAX_BODY_BYTES;
  const slice = truncated ? bytes.subarray(0, INSPECTOR_MAX_BODY_BYTES) : bytes;
  const decoded = new TextDecoder('utf-8', { fatal: true });
  let textValue: string | undefined;
  try {
    textValue = decoded.decode(slice);
  } catch {
    textValue = undefined;
  }
  if (textValue === undefined) {
    const encoded = Buffer.from(slice).toString('base64');
    return {
      encoding: 'base64',
      body: encoded,
      truncated,
      preview: `(binary, ${bytes.byteLength} bytes)`,
    };
  }
  if (!truncated) {
    try {
      const parsed = JSON.parse(textValue) as JsonValue;
      if (typeof parsed === 'object' && parsed !== null) {
        const masked = redactor.redact(parsed) as JsonValue;
        return {
          encoding: 'json',
          body: masked,
          truncated,
          preview: JSON.stringify(masked).slice(0, PREVIEW_CHARS),
        };
      }
    } catch {
      /* plain text */
    }
  }
  const masked = redactor.redactText(textValue);
  return { encoding: 'text', body: masked, truncated, preview: masked.slice(0, PREVIEW_CHARS) };
};

const toJsonValue = (value: unknown, redactor: Redactor): JsonValue => {
  try {
    return redactor.redact(JSON.parse(JSON.stringify(value ?? null))) as JsonValue;
  } catch {
    return null;
  }
};

export type NewInspectorMessage = {
  watchId?: string;
  origin: InspectorOrigin;
  environmentId: string;
  target: string;
  entity: string;
  subscription?: string;
  sequenceNumber?: string;
  detail: Omit<
    InspectedMessage,
    'id' | 'seq' | 'receivedAt' | 'origin' | 'environmentId' | 'target' | 'entity'
  > &
    Partial<Pick<InspectedMessage, 'subscription' | 'watchId'>>;
};

export type InspectorRepositoryOptions = {
  db: Database;
  redactor: Redactor;
  clock?: Clock;
  /** Oldest messages are dropped beyond this many. */
  maxMessages?: number;
};

/** Persistence for the Service Bus Inspector; also the sink Service Bus Steps write to. */
export class SqliteInspectorRepository implements InspectorSink {
  readonly #db: Database;
  readonly #redactor: Redactor;
  readonly #clock: Clock;
  readonly maxMessages: number;

  constructor(options: InspectorRepositoryOptions) {
    this.#db = options.db;
    this.#redactor = options.redactor;
    this.#clock = options.clock ?? systemClock;
    this.maxMessages = options.maxMessages ?? DEFAULT_INSPECTOR_MAX_MESSAGES;
  }

  // --- watches -------------------------------------------------------------------------------

  listWatches(): InspectorWatch[] {
    return (
      this.#db.prepare('SELECT * FROM sb_inspector_watches ORDER BY rowid').all() as Row[]
    ).map(rowToWatch);
  }

  getWatch(id: string): InspectorWatch | undefined {
    const row = this.#db.prepare('SELECT * FROM sb_inspector_watches WHERE id = ?').get(id) as
      Row | undefined;
    return row ? rowToWatch(row) : undefined;
  }

  /** The peek cursor (last seen sequence number) of a watch, if any message was seen. */
  getCursor(id: string): string | undefined {
    const row = this.#db
      .prepare('SELECT cursor_sequence FROM sb_inspector_watches WHERE id = ?')
      .get(id) as Row | undefined;
    return text(row?.cursor_sequence);
  }

  /** Adds a watch, or returns the existing one for the same entity. */
  addWatch(input: InspectorWatchInput & { source: InspectorWatchSource; createdBy: string }): {
    watch: InspectorWatch;
    created: boolean;
  } {
    const subscription = input.subscription ?? '';
    const existing = this.#db
      .prepare(
        'SELECT * FROM sb_inspector_watches WHERE environment_id = ? AND target = ? AND entity = ? AND subscription = ?',
      )
      .get(input.environmentId, input.target, input.entity, subscription) as Row | undefined;
    if (existing) return { watch: rowToWatch(existing), created: false };
    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO sb_inspector_watches (id, environment_id, target, entity, subscription, source, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.environmentId,
        input.target,
        input.entity,
        subscription,
        input.source,
        this.#clock.now().toISOString(),
        input.createdBy,
      );
    return { watch: this.getWatch(id) as InspectorWatch, created: true };
  }

  /** Stops watching; messages already collected stay until cleared. */
  removeWatch(id: string): boolean {
    return this.#db.prepare('DELETE FROM sb_inspector_watches WHERE id = ?').run(id).changes > 0;
  }

  recordPollSuccess(id: string): void {
    this.#db
      .prepare(
        'UPDATE sb_inspector_watches SET last_polled_at = ?, last_error_code = NULL, last_error_at = NULL WHERE id = ?',
      )
      .run(this.#clock.now().toISOString(), id);
  }

  recordPollFailure(id: string, code: string): void {
    const now = this.#clock.now().toISOString();
    this.#db
      .prepare(
        'UPDATE sb_inspector_watches SET last_polled_at = ?, last_error_code = ?, last_error_at = ? WHERE id = ?',
      )
      .run(now, code, now, id);
  }

  // --- messages ------------------------------------------------------------------------------

  /** Stores peeked messages for a watch (deduplicated) and advances the cursor, atomically. */
  storePeeked(
    watch: Pick<InspectorWatch, 'id' | 'environmentId' | 'target' | 'entity' | 'subscription'>,
    messages: readonly PeekedMessage[],
  ): number {
    if (messages.length === 0) return 0;
    return transaction(this.#db, () => {
      let stored = 0;
      let cursor: bigint | undefined;
      for (const message of messages) {
        const body = describeBody(message.body, message.contentType, this.#redactor);
        const detail: NewInspectorMessage['detail'] = {
          sizeBytes: message.body.byteLength,
          preview: body.preview,
          bodyEncoding: body.encoding,
          body: body.body,
          bodyTruncated: body.truncated,
          sequenceNumber: message.sequenceNumber,
          applicationProperties: toJsonValue(
            message.applicationProperties,
            this.#redactor,
          ) as Record<string, JsonValue>,
          ...(message.messageId ? { messageId: message.messageId } : {}),
          ...(message.correlationId ? { correlationId: message.correlationId } : {}),
          ...(message.sessionId ? { sessionId: message.sessionId } : {}),
          ...(message.partitionKey ? { partitionKey: message.partitionKey } : {}),
          ...(message.subject ? { subject: message.subject } : {}),
          ...(message.contentType ? { contentType: message.contentType } : {}),
          ...(message.to ? { to: message.to } : {}),
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
          ...(message.enqueuedTime ? { enqueuedTime: message.enqueuedTime } : {}),
          ...(message.scheduledEnqueueTime
            ? { scheduledEnqueueTime: message.scheduledEnqueueTime }
            : {}),
          ...(message.expiresAt ? { expiresAt: message.expiresAt } : {}),
          ...(message.timeToLiveMs !== undefined ? { timeToLiveMs: message.timeToLiveMs } : {}),
          ...(message.deliveryCount !== undefined ? { deliveryCount: message.deliveryCount } : {}),
          ...(message.lockedUntil ? { lockedUntil: message.lockedUntil } : {}),
          ...(message.deadLetterReason
            ? { deadLetterReason: this.#redactor.redactText(message.deadLetterReason) }
            : {}),
        };
        const runProperty = (detail.applicationProperties as Record<string, JsonValue>)
          .platform_run_id;
        const runId = typeof runProperty === 'string' ? runProperty : undefined;
        const inserted = this.#insert({
          watchId: watch.id,
          origin: 'received',
          environmentId: watch.environmentId,
          target: watch.target,
          entity: watch.entity,
          ...(watch.subscription ? { subscription: watch.subscription } : {}),
          sequenceNumber: message.sequenceNumber,
          detail: { ...detail, ...(runId ? { runId } : {}) },
        });
        if (inserted) stored += 1;
        try {
          const seq = BigInt(message.sequenceNumber);
          if (cursor === undefined || seq > cursor) cursor = seq;
        } catch {
          /* a non-numeric sequence number cannot advance the cursor */
        }
      }
      if (cursor !== undefined) {
        this.#db
          .prepare(
            'UPDATE sb_inspector_watches SET cursor_sequence = ?, received_count = received_count + ? WHERE id = ?',
          )
          .run(cursor.toString(), stored, watch.id);
      }
      this.#prune();
      return stored;
    });
  }

  /** InspectorSink: records a copy of a message a Step just sent. */
  async recordSent(message: InspectorSentMessage): Promise<void> {
    const body = describeBody(message.body, message.contentType, this.#redactor);
    transaction(this.#db, () => {
      this.#insert({
        origin: 'sent',
        environmentId: message.environmentId,
        target: message.target,
        entity: message.entity,
        ...(message.subscription ? { subscription: message.subscription } : {}),
        detail: {
          sizeBytes: message.body.byteLength,
          preview: body.preview,
          bodyEncoding: body.encoding,
          body: body.body,
          bodyTruncated: body.truncated,
          messageId: message.messageId,
          correlationId: message.correlationId,
          contentType: message.contentType,
          ...(message.subject ? { subject: message.subject } : {}),
          applicationProperties: toJsonValue(
            message.applicationProperties,
            this.#redactor,
          ) as Record<string, JsonValue>,
          runId: message.runId,
          stepRunId: message.stepRunId,
          nodeId: message.nodeId,
        },
      });
      this.#prune();
    });
  }

  /** InspectorSink: Steps register the entity they send to; no-op when already watched. */
  async registerWatch(
    input: InspectorWatchInput & { createdBy: string },
  ): Promise<{ created: boolean }> {
    const { created } = this.addWatch({ ...input, source: 'step' });
    return { created };
  }

  #insert(message: NewInspectorMessage): boolean {
    const id = randomUUID();
    const { detail } = message;
    const full: InspectedMessage = {
      ...detail,
      id,
      seq: 0,
      origin: message.origin,
      receivedAt: this.#clock.now().toISOString(),
      environmentId: message.environmentId,
      target: message.target,
      entity: message.entity,
      ...(message.subscription ? { subscription: message.subscription } : {}),
      ...(message.watchId ? { watchId: message.watchId } : {}),
    };
    const result = this.#db
      .prepare(
        `INSERT OR IGNORE INTO sb_inspector_messages
           (id, watch_id, origin, received_at, environment_id, target, entity, subscription, message_id,
            subject, content_type, size_bytes, preview, run_id, sequence_number, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        message.watchId ?? null,
        message.origin,
        full.receivedAt,
        message.environmentId,
        message.target,
        message.entity,
        message.subscription ?? '',
        detail.messageId ?? null,
        detail.subject ?? null,
        detail.contentType ?? null,
        detail.sizeBytes,
        detail.preview,
        detail.runId ?? null,
        message.sequenceNumber ?? null,
        toJson(full) as string,
      );
    return result.changes > 0;
  }

  #prune(): void {
    this.#db
      .prepare(
        `DELETE FROM sb_inspector_messages WHERE seq <= (
           SELECT seq FROM sb_inspector_messages ORDER BY seq DESC LIMIT 1 OFFSET ?)`,
      )
      .run(this.maxMessages);
  }

  list(options: { limit?: number; before?: number; watchId?: string } = {}): InspectorMessagePage {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (options.before !== undefined) {
      where.push('seq < ?');
      params.push(options.before);
    }
    if (options.watchId) {
      where.push('watch_id = ?');
      params.push(options.watchId);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.#db
      .prepare(
        `SELECT seq, id, watch_id, origin, received_at, environment_id, target, entity, subscription,
                message_id, subject, content_type, size_bytes, preview, run_id
         FROM sb_inspector_messages ${clause} ORDER BY seq DESC LIMIT ?`,
      )
      .all(...params, limit + 1) as Row[];
    const items = rows.slice(0, limit).map(rowToSummary);
    const total = Number(
      (this.#db.prepare('SELECT COUNT(*) AS n FROM sb_inspector_messages').get() as Row).n,
    );
    const last = items.at(-1);
    return {
      items,
      total,
      ...(rows.length > limit && last ? { nextBefore: last.seq } : {}),
    };
  }

  get(id: string): InspectedMessage | undefined {
    const row = this.#db
      .prepare('SELECT seq, detail FROM sb_inspector_messages WHERE id = ?')
      .get(id) as Row | undefined;
    if (!row) return undefined;
    const detail = fromJson<InspectedMessage>(row.detail);
    return detail ? { ...detail, seq: Number(row.seq) } : undefined;
  }

  /** Removes every collected message (the manual clear). Watches stay registered. */
  clear(): number {
    return this.#db.prepare('DELETE FROM sb_inspector_messages').run().changes as number;
  }

  summary(): InspectorSummary {
    const stats = this.#db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(MAX(seq), 0) AS last_seq FROM sb_inspector_messages`,
      )
      .get() as Row;
    const viewed = Number(
      (this.#db.prepare('SELECT last_viewed_seq FROM sb_inspector_state WHERE id = 1').get() as Row)
        .last_viewed_seq,
    );
    const unread = Number(
      (
        this.#db
          .prepare('SELECT COUNT(*) AS n FROM sb_inspector_messages WHERE seq > ?')
          .get(viewed) as Row
      ).n,
    );
    return {
      watches: this.listWatches(),
      unread,
      total: Number(stats.total),
      lastSeq: Number(stats.last_seq),
      lastViewedSeq: viewed,
      maxMessages: this.maxMessages,
    };
  }

  /** Marks everything up to `upToSeq` as seen (the badge counts only newer messages). */
  markViewed(upToSeq: number): void {
    this.#db
      .prepare(
        'UPDATE sb_inspector_state SET last_viewed_seq = MAX(last_viewed_seq, ?) WHERE id = 1',
      )
      .run(upToSeq);
  }

  /** The "last viewed" position, so the UI can highlight what arrived since. */
  lastViewedSeq(): number {
    return Number(
      (this.#db.prepare('SELECT last_viewed_seq FROM sb_inspector_state WHERE id = 1').get() as Row)
        .last_viewed_seq,
    );
  }
}
