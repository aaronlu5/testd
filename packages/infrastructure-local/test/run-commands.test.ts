import { afterEach, describe, expect, it } from 'vitest';
import {
  SqliteAuditLog,
  SqliteJobQueue,
  SqliteRunCommands,
  SqliteRunEvents,
  SqliteRunRepository,
} from '../src/index.js';
import { FakeClock, cleanupAll, makeRun, openMigrated } from './helpers.js';

afterEach(cleanupAll);

const setup = async () => {
  const { db } = await openMigrated();
  const clock = new FakeClock();
  const runs = new SqliteRunRepository(db);
  const jobs = new SqliteJobQueue(db, clock);
  const events = new SqliteRunEvents(db);
  const audit = new SqliteAuditLog(db, clock);
  const commands = new SqliteRunCommands({ db, runs, jobs, events, audit, clock });
  const count = (table: string): number =>
    Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  return { db, clock, runs, jobs, events, commands, count };
};

describe('SqliteRunCommands', () => {
  it('stores the run, queues its job, publishes the first event, and audits together', async () => {
    const { commands, count, jobs, events, clock } = await setup();
    const { run, job } = await commands.submit({
      run: makeRun('r1'),
      maxAttempts: 5,
      audit: { actor: 'ann', action: 'run.create', entityType: 'run', entityId: 'r1' },
    });
    expect(run.id).toBe('r1');
    expect(job).toMatchObject({ runId: 'r1', status: 'queued', maxAttempts: 5 });
    expect([count('runs'), count('jobs'), count('run_events'), count('audit_events')]).toEqual([
      1, 1, 1, 1,
    ]);
    expect((await events.listSince('r1'))[0]).toMatchObject({
      type: 'run.status',
      data: { status: 'Queued' },
    });

    clock.advance(1);
    expect((await jobs.claim({ workerId: 'w', leaseMs: 1000 }))?.id).toBe(job.id);
  });

  it('rolls everything back when any part of the submission fails', async () => {
    const { commands, count } = await setup();
    await expect(
      commands.submit({
        run: makeRun('r1'),
        // BigInt cannot be serialised, so the audit write fails after the run and job were inserted.
        audit: {
          actor: 'a',
          action: 'x',
          entityType: 'run',
          entityId: 'r1',
          metadata: { n: 1n as never },
        },
      }),
    ).rejects.toThrow();
    expect([count('runs'), count('jobs'), count('run_events'), count('audit_events')]).toEqual([
      0, 0, 0, 0,
    ]);

    await commands.submit({ run: makeRun('r1') });
    await expect(commands.submit({ run: makeRun('r1') })).rejects.toThrow(); // duplicate id
    expect([count('runs'), count('jobs'), count('run_events')]).toEqual([1, 1, 1]);
  });

  it('cancels a queued run, its job, and records the event in one step', async () => {
    const { commands, db, events } = await setup();
    await commands.submit({ run: makeRun('r1') });
    const result = await commands.requestCancel({
      runId: 'r1',
      at: '2026-01-01T00:00:05.000Z',
      audit: { actor: 'ann', action: 'run.cancel', entityType: 'run', entityId: 'r1' },
    });
    expect(result).toMatchObject({ outcome: 'applied', current: { status: 'Cancelled' } });
    expect(db.prepare('SELECT status FROM jobs').get()).toEqual({ status: 'cancelled' });
    expect(
      (await events.listSince('r1')).map((e) => (e.data as { status: string }).status),
    ).toEqual(['Queued', 'Cancelled']);

    const again = await commands.requestCancel({ runId: 'r1', at: 'later' });
    expect(again.outcome).toBe('noop');
    expect((await events.listSince('r1')).length).toBe(2);
  });

  it('requests cooperative cancellation for running runs and leaves the job leased', async () => {
    const { commands, runs, jobs, clock, db } = await setup();
    await commands.submit({ run: makeRun('r1') });
    clock.advance(1);
    await jobs.claim({ workerId: 'w', leaseMs: 60_000 });
    await runs.transitionRun('r1', { from: 'Queued', to: 'Running', at: clock.iso() });

    const result = await commands.requestCancel({ runId: 'r1', at: clock.iso() });
    expect(result).toMatchObject({ outcome: 'applied', current: { status: 'Cancelling' } });
    expect(db.prepare('SELECT status FROM jobs').get()).toEqual({ status: 'leased' });
  });

  it('rejects cancelling unknown or finished runs without side effects', async () => {
    const { commands, runs, events, count } = await setup();
    expect((await commands.requestCancel({ runId: 'missing', at: 'x' })).outcome).toBe('rejected');
    await commands.submit({ run: makeRun('r1') });
    await runs.transitionRun('r1', { from: 'Queued', to: 'Running', at: 'x' });
    await runs.transitionRun('r1', { from: 'Running', to: 'Succeeded', at: 'x' });
    expect((await commands.requestCancel({ runId: 'r1', at: 'y' })).outcome).toBe('rejected');
    expect(await events.listSince('r1')).toHaveLength(1);
    expect(count('audit_events')).toBe(0);
  });
});
