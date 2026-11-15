import type { JsonValue, StepLogEntry } from '@test-platform/contracts';
import type { Clock } from '@test-platform/core';
import type { StepLogger } from './types.js';

const MAX_ENTRIES = 1000;

export const createStepLogger = (
  clock: Clock,
  onEntry?: (entry: StepLogEntry) => void,
): StepLogger => {
  const recorded: StepLogEntry[] = [];
  const record =
    (level: StepLogEntry['level']) =>
    (message: string, data?: JsonValue): void => {
      if (recorded.length >= MAX_ENTRIES) return;
      const entry: StepLogEntry = { timestamp: clock.now().toISOString(), level, message };
      if (data !== undefined) entry.data = data;
      recorded.push(entry);
      onEntry?.(entry);
    };
  return {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    entries: () => recorded,
  };
};
