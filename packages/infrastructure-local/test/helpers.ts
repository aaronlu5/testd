import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Run, StepRun } from '@test-platform/contracts';
import type { Clock } from '@test-platform/core';
import { SqliteRunRepository, migrate, openDatabase, type Database } from '../src/index.js';

export class FakeClock implements Clock {
  ms: number;
  constructor(start = '2026-01-01T00:00:00.000Z') {
    this.ms = Date.parse(start);
  }
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  iso(): string {
    return this.now().toISOString();
  }
}

const cleanups: (() => Promise<void> | void)[] = [];

export const onCleanup = (fn: () => Promise<void> | void): void => {
  cleanups.push(fn);
};

export const cleanupAll = async (): Promise<void> => {
  while (cleanups.length > 0) await cleanups.pop()?.();
};

export const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-infra-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
};

export const openMigrated = async (
  file = 'platform.db',
): Promise<{ db: Database; dir: string }> => {
  const dir = await makeTempDir();
  const db = openDatabase({ path: join(dir, file) });
  cleanups.push(() => {
    try {
      db.close();
    } catch {
      // already closed by the test
    }
  });
  migrate(db);
  return { db, dir };
};

export const makeRun = (id: string, overrides: Partial<Run> = {}): Run => ({
  id,
  kind: 'test',
  status: 'Queued',
  environmentId: 'local-example',
  requestedBy: 'tester@example.test',
  requestedAt: '2026-01-01T00:00:00.000Z',
  test: { id: '01JTEST8M2B5D4KQ7XNH3WV9ZA', version: 1 },
  testData: { id: '01JDATA0N5C6E7MR8YPJ4XW1BC', version: 1 },
  variableOverrides: { region: 'eu' },
  snapshots: {
    environment: { id: 'local-example', name: 'Local', classification: 'TEST', targets: {} },
  },
  ...overrides,
});

export const makeStepRun = (
  id: string,
  runId: string,
  overrides: Partial<StepRun> = {},
): StepRun => ({
  id,
  runId,
  nodeId: 'node-1',
  attempt: 1,
  status: 'Queued',
  logs: [],
  artifacts: [],
  ...overrides,
});

export const seedRun = async (
  db: Database,
  runId = 'run-1',
  stepRunId = 'step-1',
): Promise<void> => {
  const runs = new SqliteRunRepository(db);
  await runs.createRun(makeRun(runId));
  await runs.createStepRun(makeStepRun(stepRunId, runId));
};
