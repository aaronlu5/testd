import type { JsonValue } from './json.js';

/**
 * Service Bus Inspector: a local, read-only view of messages seen on Service Bus entities.
 * The inspector only ever *peeks* (it never receives, completes or deletes), so it cannot take a
 * message away from the real consumer, and it records a copy of each message a Service Bus Step
 * sends so that a message consumed instantly can still be inspected.
 */

/** Where a stored message came from. */
export const INSPECTOR_ORIGINS = ['received', 'sent'] as const;
export type InspectorOrigin = (typeof INSPECTOR_ORIGINS)[number];

/** `step` watches were registered by a Service Bus Step; `manual` ones by a person. */
export const INSPECTOR_WATCH_SOURCES = ['manual', 'step'] as const;
export type InspectorWatchSource = (typeof INSPECTOR_WATCH_SOURCES)[number];

/** A queue, or one subscription of a topic, that the worker peeks at. */
export type InspectorWatch = {
  id: string;
  environmentId: string;
  /** Logical Service Bus target in that Environment. */
  target: string;
  /** Queue or topic name; must be allowed by the target. */
  entity: string;
  /** Present for a topic: the subscription to peek. Absent for a queue. */
  subscription?: string;
  source: InspectorWatchSource;
  createdAt: string;
  createdBy: string;
  /** Last time the worker finished a peek of this watch. */
  lastPolledAt?: string;
  /** Error code of the last failed peek (never a message), cleared by the next success. */
  lastErrorCode?: string;
  lastErrorAt?: string;
  /** Messages stored for this watch since it was created. */
  receivedCount: number;
};

export type InspectorWatchInput = {
  environmentId: string;
  target: string;
  entity: string;
  subscription?: string;
};

/** Maximum body bytes stored per message; longer bodies are cut and flagged. */
export const INSPECTOR_MAX_BODY_BYTES = 256 * 1024;

export type InspectorBodyEncoding = 'json' | 'text' | 'base64' | 'empty';

/** Compact form used in lists. */
export type InspectedMessageSummary = {
  id: string;
  /** Monotonic position in the store; used for "new" tracking and paging. */
  seq: number;
  origin: InspectorOrigin;
  /** When the platform stored it. */
  receivedAt: string;
  watchId?: string;
  environmentId: string;
  target: string;
  entity: string;
  subscription?: string;
  messageId?: string;
  subject?: string;
  contentType?: string;
  sizeBytes: number;
  /** First characters of the body, already masked, for the list row. */
  preview: string;
  /** Set when the message was sent by a Step of a Run (always for `sent`, via properties for `received`). */
  runId?: string;
};

/** Full message as shown in the detail view. Body and properties are already masked. */
export type InspectedMessage = InspectedMessageSummary & {
  correlationId?: string;
  sessionId?: string;
  partitionKey?: string;
  to?: string;
  replyTo?: string;
  enqueuedTime?: string;
  scheduledEnqueueTime?: string;
  expiresAt?: string;
  timeToLiveMs?: number;
  deliveryCount?: number;
  /** Service Bus sequence number (a 64-bit integer, kept as text). */
  sequenceNumber?: string;
  lockedUntil?: string;
  deadLetterReason?: string;
  applicationProperties: Record<string, JsonValue>;
  bodyEncoding: InspectorBodyEncoding;
  body: JsonValue;
  bodyTruncated: boolean;
  stepRunId?: string;
  nodeId?: string;
};

export type InspectorSummary = {
  watches: InspectorWatch[];
  /** Messages stored since the panel was last opened. */
  unread: number;
  total: number;
  /** Highest `seq` in the store (0 when empty). */
  lastSeq: number;
  /** Everything up to this `seq` was already seen when the panel was last opened. */
  lastViewedSeq: number;
  /** Oldest messages are dropped beyond this many, to protect local disk. */
  maxMessages: number;
};

export type InspectorMessagePage = {
  items: InspectedMessageSummary[];
  total: number;
  /** `seq` of the last item, to request the next (older) page. */
  nextBefore?: number;
};
