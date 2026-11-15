import type { StepRunStatus } from '@test-platform/contracts';
import { createTargetPolicy, createTargetResolver, type Clock } from '@test-platform/core';
import type { StepExecutionContext } from '../src/index.js';

export const realClock: Clock = { now: () => new Date() };

export const makeContext = (
  overrides: Partial<Omit<StepExecutionContext, 'logger'>> = {},
): Omit<StepExecutionContext, 'logger'> => ({
  signal: new AbortController().signal,
  artifacts: { write: () => Promise.reject(new Error('artifacts are not available in tests')) },
  targets: createTargetResolver({ id: 'test', targets: {} }),
  secrets: { getSecret: () => Promise.resolve(undefined) },
  secretReferences: {
    resolve: () => Promise.reject(new Error('secret references are not available in tests')),
    checkReadiness: () => Promise.resolve('unconfigured'),
    sensitiveValues: () => [],
  },
  policy: createTargetPolicy({ id: 'test', targets: {} }),
  clients: {
    http: { send: () => Promise.reject(new Error('http is not available in tests')) },
    openBlob: () => {
      throw new Error('blob is not available in tests');
    },
    openSql: () => {
      throw new Error('sql is not available in tests');
    },
    openServiceBus: () => {
      throw new Error('service bus is not available in tests');
    },
  },
  limits: { payloadBytes: 64 * 1024, transferBytes: 1024 * 1024 },
  environmentId: 'test',
  inspector: {
    registerWatch: () => Promise.resolve({ created: false }),
    recordSent: () => Promise.resolve(),
  },
  clock: realClock,
  correlation: { runId: 'run-1', stepRunId: 'step-run-1', nodeId: 'node', attempt: 1 },
  ...overrides,
});

export type { StepRunStatus };
