import { randomUUID } from 'node:crypto';
import { PlatformError } from '@test-platform/core';

/** Identifiers usable as path segments: UUIDs, ULIDs, and similar generated ids. */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const newId = (): string => randomUUID();

export const assertSafeId = (value: string, label: string): string => {
  if (!SAFE_ID.test(value)) {
    throw new PlatformError('VALIDATION_REFERENCE', `${label} is not a valid identifier.`);
  }
  return value;
};
