import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { computeBackoffMs, effectiveRetryPolicy } from '@test-platform/core';
import { SqliteJobQueue, SqliteRunRepository, openDatabase } from '../src/index.js';
import { FakeClock, cleanupAll, makeRun, openMigrated } from './helpers.js';

afterEach(cleanupAll);

const setup = async (jobCount = 0) => {
  const { db, dir } = await openMigrated();
  const clock = new FakeClock();
  const runs = new SqliteRunRepository(db);
  const queue = new SqliteJobQueue(db, clock);
  const jobs = [];
  for (let i = 0; i < jobCount; i += 1) {
    await runs.createRun(makeRun(`run-${i}`));
    clock.advance(1);
    jobs.push(await queue.enqueue({ runId: `run-${i}` }));
  }
  return { db, dir, clock, runs, queue, jobs };
};

describe('SqliteJobQueue', () => {
  it('claims the oldest eligible job first and records the lease', async () => {
    const { queue, clock, jobs } = await setup(3);
    clock.advance(10);
    const claimed = await queue.claim({ workerId: 'w1', leaseMs: 30_000 });
    expect(claimed).toMatchObject({
      id: jobs[0]?.id,
      status: 'leased',
      leaseOwner: 'w1',
      attempts: 1,
    });
    expect(claimed?.leaseExpiresAt).toBe(new Date(clock.ms + 30_000).toISOString());
    expect((await queue.claim({ workerId: 'w2', leaseMs: 1000 }))?.id).toBe(jobs[1]?.id);
  });

  it('does not hand out jobs before availableAt or jobs that are already leased', async () => {
    const { queue, clock, runs } = await setup();
    await runs.createRun(makeRun('later'));
    await queue.enqueue({ runId: 'later', availableAt: new Date(clock.ms + 5000).toISOString() });
    expect(await queue.claim({ workerId: 'w', leaseMs: 1000 })).toBeUndefined();
    clock.advance(5000);
    expect(await queue.claim({ workerId: 'w', leaseMs: 1000 })).toBeDefined();
    expect(await queue.claim({ workerId: 'w2', leaseMs: 1000 })).toBeUndefined();
  });

  it('gives each job to exactly one of several connections claiming interleaved', async () => {
    const { db, dir, clock, jobs } = await setup(40);
    const other = openDatabase({ path: join(dir, 'platform.db') });
    try {
      clock.advance(1);
      const queues = [new SqliteJobQueue(db, clock), new SqliteJobQueue(other, clock)];
      const claimed: string[] = [];
      for (let turn = 0; ; turn += 1) {
        const job = await queues[turn % 2]?.claim({ workerId: `w${turn % 2}`, leaseMs: 60_000 });
        if (!job) break;
        claimed.push(job.id);
      }
      expect(claimed).toHaveLength(40);
      expect(new Set(claimed).size).toBe(40);
      expect(new Set(claimed)).toEqual(new Set(jobs.map((job) => job.id)));
    } finally {
      other.close();
    }
  });

  it('gives each job to exactly one of several concurrent threads (separate connections)', async () => {
    const { dir, clock } = await setup(60);
    clock.advance(1);
    const dbPath = join(dir, 'platform.db');
    const entry = pathToFileURL(fileURLToPath(new URL('../dist/index.js', import.meta.url))).href;
    const script = `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { SqliteJobQueue, openDatabase } = await import(workerData.entry);
        const db = openDatabase({ path: workerData.dbPath });
        const queue = new SqliteJobQueue(db, { now: () => new Date(workerData.now) });
        const ids = [];
        for (;;) {
          const job = await queue.claim({ workerId: workerData.id, leaseMs: 60000 });
          if (!job) break;
          ids.push(job.id);
        }
        db.close();
        parentPort.postMessage(ids);
      })().catch((error) => { parentPort.postMessage({ error: String(error) }); });
    `;
    const results = await Promise.all(
      [0, 1, 2, 3].map(
        (id) =>
          new Promise<string[]>((resolve, reject) => {
            const worker = new Worker(script, {
              eval: true,
              workerData: { entry, dbPath, now: clock.ms, id: `thread-${id}` },
            });
            worker.once('message', (message: string[] | { error: string }) =>
              Array.isArray(message) ? resolve(message) : reject(new Error(message.error)),
            );
            worker.once('error', reject);
          }),
      ),
    );
    const all = results.flat();
    expect(all).toHaveLength(60);
    expect(new Set(all).size).toBe(60);
  });

  it('renews leases only for the owner while the job is leased', async () => {
    const { queue, clock } = await setup(1);
    clock.advance(1);
    const job = (await queue.claim({ workerId: 'owner', leaseMs: 1000 }))!;
    clock.advance(500);
    expect(await queue.renewLease({ jobId: job.id, workerId: 'intruder', leaseMs: 1000 })).toBe(
      false,
    );
    expect(await queue.renewLease({ jobId: job.id, workerId: 'owner', leaseMs: 1000 })).toBe(true);
    expect((await queue.get(job.id))?.leaseExpiresAt).toBe(new Date(clock.ms + 1000).toISOString());
    await queue.complete({ jobId: job.id, workerId: 'owner' });
    expect(await queue.renewLease({ jobId: job.id, workerId: 'owner', leaseMs: 1000 })).toBe(false);
  });

  it('completes idempotently and rejects other workers', async () => {
    const { queue, clock } = await setup(1);
    clock.advance(1);
    const job = (await queue.claim({ workerId: 'w1', leaseMs: 1000 }))!;
    expect(await queue.complete({ jobId: job.id, workerId: 'w2' })).toBe('rejected');
    expect(await queue.complete({ jobId: job.id, workerId: 'w1' })).toBe('applied');
    expect(await queue.complete({ jobId: job.id, workerId: 'w1' })).toBe('noop');
    expect(await queue.fail({ jobId: job.id, workerId: 'w1', error: 'late' })).toBe('rejected');
    expect(await queue.complete({ jobId: 'missing', workerId: 'w1' })).toBe('rejected');
    expect((await queue.get(job.id))?.status).toBe('completed');
  });

  it('recovers jobs whose lease expired and lets another worker claim them', async () => {
    const { queue, clock } = await setup(1);
    clock.advance(1);
    const job = (await queue.claim({ workerId: 'crashed', leaseMs: 1000 }))!;
    expect(await queue.recoverExpired()).toEqual({ requeued: 0, failed: 0 });

    clock.advance(1000);
    expect(await queue.recoverExpired()).toEqual({ requeued: 1, failed: 0 });
    expect(await queue.get(job.id)).toMatchObject({ status: 'queued', attempts: 1 });
    expect((await queue.get(job.id))?.leaseOwner).toBeUndefined();

    const reclaimed = await queue.claim({ workerId: 'healthy', leaseMs: 1000 });
    expect(reclaimed).toMatchObject({ id: job.id, leaseOwner: 'healthy', attempts: 2 });
    // The crashed worker can no longer finish or renew the job.
    expect(await queue.complete({ jobId: job.id, workerId: 'crashed' })).toBe('rejected');
    expect(await queue.renewLease({ jobId: job.id, workerId: 'crashed', leaseMs: 1000 })).toBe(
      false,
    );
  });

  it('fails jobs that keep expiring once maxAttempts is reached', async () => {
    const { queue, clock, runs } = await setup();
    await runs.createRun(makeRun('flaky'));
    const job = await queue.enqueue({ runId: 'flaky', maxAttempts: 2 });
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      clock.advance(1);
      await queue.claim({ workerId: 'w', leaseMs: 100 });
      clock.advance(100);
      await queue.recoverExpired();
    }
    expect(await queue.get(job.id)).toMatchObject({ status: 'failed', attempts: 2 });
    expect(await queue.claim({ workerId: 'w', leaseMs: 100 })).toBeUndefined();
  });

  it('schedules retries with backoff and releases the lease', async () => {
    const { queue, clock } = await setup(1);
    clock.advance(1);
    const job = (await queue.claim({ workerId: 'w', leaseMs: 60_000 }))!;
    const delay = computeBackoffMs(
      1,
      effectiveRetryPolicy({ maxAttempts: 3, initialDelayMs: 2000 }),
    );
    const availableAt = new Date(clock.ms + delay).toISOString();

    expect(
      await queue.reschedule({
        jobId: job.id,
        workerId: 'w',
        availableAt,
        error: 'TARGET_SERVICE',
      }),
    ).toBe('applied');
    expect(await queue.get(job.id)).toMatchObject({
      status: 'queued',
      availableAt,
      lastError: 'TARGET_SERVICE',
    });
    expect(await queue.claim({ workerId: 'w', leaseMs: 1000 })).toBeUndefined();

    clock.advance(delay);
    expect(await queue.claim({ workerId: 'w', leaseMs: 1000 })).toMatchObject({
      id: job.id,
      attempts: 2,
    });
    expect(
      await queue.reschedule({ jobId: job.id, workerId: 'other', availableAt, error: 'x' }),
    ).toBe('rejected');
  });

  it('cancels jobs that have not been claimed', async () => {
    const { queue, jobs, clock } = await setup(2);
    clock.advance(1);
    expect(await queue.cancelQueued('run-0')).toBe(true);
    expect(await queue.cancelQueued('run-0')).toBe(false);
    expect((await queue.get(jobs[0]!.id))?.status).toBe('cancelled');
    expect((await queue.claim({ workerId: 'w', leaseMs: 1000 }))?.id).toBe(jobs[1]?.id);
  });

  it('keeps queued work across a restart (new connection to the same file)', async () => {
    const { db, dir, clock, jobs } = await setup(2);
    db.close();
    const reopened = openDatabase({ path: join(dir, 'platform.db') });
    try {
      clock.advance(1);
      const queue = new SqliteJobQueue(reopened, clock);
      expect((await queue.claim({ workerId: 'after-restart', leaseMs: 1000 }))?.id).toBe(
        jobs[0]?.id,
      );
    } finally {
      reopened.close();
    }
  });
});
