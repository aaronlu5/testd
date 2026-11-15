/**
 * Ports for the worker-side clients that target Steps use. The Azure SDKs are bound to these in
 * `@test-platform/infrastructure-local`; Steps and their tests see only these interfaces.
 *
 * Implementations must:
 * - throw `PlatformError` (see `mapTargetFailure`) and never propagate SDK error text;
 * - receive secret values only through the `connectionString` fields, hold them in memory for
 *   the lifetime of the returned client, and drop them in `close()`.
 */

export type HttpTransportRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  signal: AbortSignal;
  /** Per-request ceiling; the transport aborts and throws a TARGET_TIMEOUT error. */
  timeoutMs: number;
  /** Bytes of response body to read; the rest is dropped and `truncated` is set. */
  maxResponseBytes: number;
};

export type HttpTransportResponse = {
  status: number;
  statusText: string;
  /** Lower-case header names. */
  headers: Record<string, string>;
  body: Uint8Array;
  truncated: boolean;
};

/** Never follows redirects: a 3xx is returned to the Step as an ordinary response. */
export interface HttpTransport {
  send(request: HttpTransportRequest): Promise<HttpTransportResponse>;
}

export type BlobProperties = {
  etag?: string;
  contentType?: string;
  contentLength: number;
  lastModified?: string;
  versionId?: string;
  metadata: Record<string, string>;
};

export interface BlobPort {
  upload(input: {
    container: string;
    blobName: string;
    content: Uint8Array;
    contentType?: string;
    /** When false the upload is conditional (`If-None-Match: *`) and reports `created: false` if the blob exists. */
    overwrite: boolean;
    metadata: Record<string, string>;
    signal: AbortSignal;
  }): Promise<{ created: true; properties: BlobProperties } | { created: false }>;
  /** Undefined when the blob does not exist. */
  getProperties(input: {
    container: string;
    blobName: string;
    signal: AbortSignal;
  }): Promise<BlobProperties | undefined>;
  /** Fails with TARGET_REQUEST (without downloading) when the blob exceeds `maxBytes`. */
  download(input: {
    container: string;
    blobName: string;
    maxBytes: number;
    signal: AbortSignal;
  }): Promise<{ content: Uint8Array; properties: BlobProperties }>;
  close(): Promise<void>;
}

export type OutgoingMessage = {
  body: Uint8Array;
  contentType: string;
  messageId: string;
  correlationId: string;
  subject?: string;
  applicationProperties: Record<string, string | number | boolean>;
};

/** A message as seen by a peek. Nothing about it is locked, settled or removed. */
export type PeekedMessage = {
  body: Uint8Array;
  contentType?: string;
  messageId?: string;
  correlationId?: string;
  sessionId?: string;
  partitionKey?: string;
  subject?: string;
  to?: string;
  replyTo?: string;
  enqueuedTime?: string;
  scheduledEnqueueTime?: string;
  expiresAt?: string;
  timeToLiveMs?: number;
  deliveryCount?: number;
  /** 64-bit sequence number, as text. */
  sequenceNumber: string;
  lockedUntil?: string;
  deadLetterReason?: string;
  applicationProperties: Record<string, unknown>;
};

export interface ServiceBusPort {
  send(input: { entity: string; message: OutgoingMessage; signal: AbortSignal }): Promise<void>;
  /**
   * Non-destructive read of up to `maxMessages` messages from a queue, or from a topic
   * `subscription`, starting at `fromSequenceNumber` (inclusive) when given. Never receives,
   * completes, abandons or deletes anything.
   */
  peek(input: {
    entity: string;
    subscription?: string;
    fromSequenceNumber?: string;
    maxMessages: number;
    signal: AbortSignal;
  }): Promise<PeekedMessage[]>;
  close(): Promise<void>;
}

export type SqlValue = string | number | boolean | null;

/** One column value as JSON-safe data: dates are ISO text, binary is base64, bigints are text. */
export type SqlRow = Record<string, string | number | boolean | null>;

export interface SqlPort {
  /** Runs one SELECT with named parameters, returning at most `maxRows` rows. */
  query(input: {
    statement: string;
    parameters: Record<string, SqlValue>;
    maxRows: number;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<{ columns: string[]; rows: SqlRow[]; truncated: boolean }>;
  /** Runs one INSERT, UPDATE or DELETE inside a transaction that commits only on success. */
  execute(input: {
    statement: string;
    parameters: Record<string, SqlValue>;
    timeoutMs: number;
    signal: AbortSignal;
    /** Roll back instead of committing when more than this many rows would be affected. */
    maxRowsAffected: number;
  }): Promise<{ rowsAffected: number }>;
  close(): Promise<void>;
}

/** Entra (`DefaultAzureCredential`) is used whenever `connectionString` is absent. */
export type BlobConnection = { accountUrl: string; connectionString?: string };
export type SqlConnection = {
  host: string;
  port?: number;
  database: string;
  connectionString?: string;
};
export type ServiceBusConnection = { fullyQualifiedNamespace: string; connectionString?: string };

export interface TargetClients {
  http: HttpTransport;
  openBlob(connection: BlobConnection): BlobPort;
  openServiceBus(connection: ServiceBusConnection): ServiceBusPort;
  openSql(connection: SqlConnection): SqlPort;
}
