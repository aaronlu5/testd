import type { JsonValue, StepLogEntry } from '@test-platform/contracts';
import { PlatformError } from '@test-platform/core';

export const TRUNCATED_KEY = '$truncated';
const MAX_LOG_MESSAGE_CHARS = 4096;

export type Capped = { value: JsonValue; truncated: boolean; sizeBytes: number };

export const serializedSize = (value: JsonValue): number => {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new PlatformError('EXECUTION_SERIALIZATION', 'A value could not be serialized.', {
      cause: error,
    });
  }
  return Buffer.byteLength(text ?? 'null');
};

/** Bounds what is persisted inline; an oversized value is replaced by a marker with a text prefix. */
export const capJson = (value: JsonValue, maxBytes: number): Capped => {
  const sizeBytes = serializedSize(value);
  if (sizeBytes <= maxBytes) return { value, truncated: false, sizeBytes };
  const budget = Math.max(maxBytes - 96, 0);
  const prefix = Buffer.from(JSON.stringify(value)).subarray(0, budget).toString('utf8');
  return {
    value: { [TRUNCATED_KEY]: true, sizeBytes, preview: prefix.replace(/�+$/u, '') },
    truncated: true,
    sizeBytes,
  };
};

export const isTruncatedPreview = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  (value as Record<string, unknown>)[TRUNCATED_KEY] === true;

/** Keeps the log list within `maxBytes`, noting how many entries were dropped. */
export const capLogs = (
  logs: readonly StepLogEntry[],
  maxBytes: number,
  now: () => string,
): StepLogEntry[] => {
  const kept: StepLogEntry[] = [];
  let used = 0;
  let dropped = 0;
  for (const entry of logs) {
    const bounded: StepLogEntry = {
      ...entry,
      message: entry.message.slice(0, MAX_LOG_MESSAGE_CHARS),
    };
    if (entry.data !== undefined) {
      bounded.data = capJson(entry.data, Math.max(Math.floor(maxBytes / 4), 256)).value;
    }
    const size = Buffer.byteLength(JSON.stringify(bounded));
    if (used + size > maxBytes - 256) {
      dropped += 1;
      continue;
    }
    used += size;
    kept.push(bounded);
  }
  if (dropped > 0) {
    kept.push({
      timestamp: now(),
      level: 'warn',
      message: `Log output was truncated; ${dropped} entr${dropped === 1 ? 'y was' : 'ies were'} omitted.`,
    });
  }
  return kept;
};
