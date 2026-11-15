import { afterEach, describe, expect, it } from 'vitest';
import { createRedactor, REDACTED } from '@test-platform/core';
import type { RunEvent } from '@test-platform/contracts';
import {
  EnvSecretProvider,
  SqliteAuditLog,
  SqliteRunEvents,
  createJsonLogger,
  openLocalInfrastructure,
} from '../src/index.js';
import {
  FakeClock,
  cleanupAll,
  makeRun,
  makeStepRun,
  makeTempDir,
  onCleanup,
  openMigrated,
} from './helpers.js';

afterEach(cleanupAll);

describe('EnvSecretProvider', () => {
  const env = {
    TEST_PLATFORM_SECRET_ORDERS_API_KEY: 'key-123',
    TEST_PLATFORM_SECRET_EMPTY: '',
    OTHER: 'not-a-secret',
    TEST_PLATFORM_SECRET_B: 'bee-456',
  };

  it('resolves names to prefixed upper-case variables', async () => {
    const provider = new EnvSecretProvider({ env });
    expect(await provider.getSecret('orders-api-key')).toBe('key-123');
    expect(await provider.getSecret('ORDERS_API_KEY')).toBe('key-123');
    expect(await provider.getSecret('missing')).toBeUndefined();
    expect(await provider.getSecret('empty')).toBeUndefined();
  });

  it('rejects malformed names and undeclared names when a declaration list is given', async () => {
    const provider = new EnvSecretProvider({ env, declaredNames: ['orders-api-key'] });
    await expect(provider.getSecret('../etc')).rejects.toMatchObject({
      code: 'VALIDATION_REFERENCE',
    });
    await expect(provider.getSecret('b')).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
    expect(await provider.getSecret('Orders-Api-Key')).toBe('key-123');
  });

  it('exposes only non-empty prefixed values for redaction', () => {
    expect(new EnvSecretProvider({ env }).sensitiveValues().sort()).toEqual(['bee-456', 'key-123']);
  });
});

describe('createJsonLogger', () => {
  const setup = (options: Parameters<typeof createJsonLogger>[0] = {}) => {
    const lines: Record<string, unknown>[] = [];
    const logger = createJsonLogger({
      clock: new FakeClock(),
      sink: (line) => lines.push(JSON.parse(line)),
      ...options,
    });
    return { lines, logger };
  };

  it('writes one structured JSON object per call and honours the level', () => {
    const { lines, logger } = setup({ level: 'warn' });
    logger.info('skipped');
    logger.warn('kept', { runId: 'r1' });
    expect(lines).toEqual([
      { runId: 'r1', time: '2026-01-01T00:00:00.000Z', level: 'warn', msg: 'kept' },
    ]);
  });

  it('merges child bindings and prevents fields from overriding reserved keys', () => {
    const { lines, logger } = setup();
    logger.child({ component: 'worker' }).info('hello', { level: 'fatal', msg: 'spoof', extra: 1 });
    expect(lines[0]).toMatchObject({ component: 'worker', extra: 1, level: 'info', msg: 'hello' });
  });

  it('masks registered secrets, sensitive keys, and error details', () => {
    const secrets = new Set<string>();
    const redactor = createRedactor({ secretValues: () => secrets });
    const { lines, logger } = setup({ redactor });

    logger.info('before registration s3cr3t-token', {});
    secrets.add('s3cr3t-token');
    logger.error('calling with s3cr3t-token', {
      url: 'https://x/?sig=s3cr3t-token',
      headers: { Authorization: 'Bearer abc' },
      err: new Error('failed for s3cr3t-token'),
    });

    expect(lines[0]?.msg).toBe('before registration s3cr3t-token');
    expect(JSON.stringify(lines[1])).not.toContain('s3cr3t-token');
    expect(lines[1]).toMatchObject({
      msg: `calling with ${REDACTED}`,
      url: `https://x/?sig=${REDACTED}`,
      headers: { Authorization: REDACTED },
      err: { name: 'Error', message: `failed for ${REDACTED}` },
    });
  });

  it('survives unserializable fields', () => {
    const { lines, logger } = setup();
    logger.info('big', { n: 10n as unknown });
    expect(lines[0]).toMatchObject({ msg: 'big', logError: 'fields were not serializable' });
  });
});

describe('audit log and run events', () => {
  it('masks secrets in audit metadata', async () => {
    const { db } = await openMigrated();
    const audit = new SqliteAuditLog(db, new FakeClock(), () => ['abc-secret-xyz']);
    await audit.append({
      actor: 'ann',
      action: 'test.save',
      entityType: 'test',
      entityId: 't1',
      metadata: { note: 'uses abc-secret-xyz', password: 'p' },
    });
    const row = db.prepare('SELECT * FROM audit_events').get() as Record<string, string>;
    expect(row).toMatchObject({
      actor: 'ann',
      action: 'test.save',
      entity_id: 't1',
      at: '2026-01-01T00:00:00.000Z',
    });
    expect(JSON.parse(row.metadata as string)).toEqual({
      note: `uses ${REDACTED}`,
      password: REDACTED,
    });
  });

  it('publishes ordered events that another connection can read incrementally', async () => {
    const { db } = await openMigrated();
    const events = new SqliteRunEvents(db);
    const event = (status: 'Running' | 'Succeeded', runId = 'r1'): RunEvent => ({
      type: 'run.status',
      runId,
      timestamp: '2026-01-01T00:00:00.000Z',
      data: { status },
    });
    await events.publish(event('Running'));
    await events.publish(event('Running', 'other'));
    await events.publish(event('Succeeded'));

    const all = await events.listSince('r1');
    expect(all.map((e) => [e.seq, e.data])).toEqual([
      [1, { status: 'Running' }],
      [3, { status: 'Succeeded' }],
    ]);
    expect((await events.listSince('r1', 1)).map((e) => e.seq)).toEqual([3]);
    expect(await events.listSince('r1', 3)).toEqual([]);
    expect(await events.listSince('r1', 0, 1)).toHaveLength(1);
  });
});

describe('openLocalInfrastructure', () => {
  it('creates runtime and definition folders, migrates, and survives a restart', async () => {
    const dir = await makeTempDir();
    const options = {
      runtimeDir: `${dir}/runtime`,
      definitionsDir: `${dir}/definitions`,
      env: {},
      logSink: () => undefined,
    };
    const first = openLocalInfrastructure(options);
    onCleanup(() => {
      try {
        first.close();
      } catch {
        // closed by the test
      }
    });
    expect(first.migration).toMatchObject({ applied: [1, 2, 3, 4, 5, 6], currentVersion: 6 });

    await first.runs.createRun(makeRun('r1'));
    await first.runs.createStepRun(makeStepRun('s1', 'r1'));
    const job = await first.jobs.enqueue({ runId: 'r1' });
    const artifact = await first.artifacts.write({
      runId: 'r1',
      stepRunId: 's1',
      content: 'hello',
      contentType: 'text/plain',
    });
    first.close();

    const second = openLocalInfrastructure(options);
    onCleanup(() => second.close());
    expect(second.migration).toMatchObject({ applied: [], currentVersion: 6 });
    expect((await second.runs.getRun('r1'))?.status).toBe('Queued');
    expect(await second.jobs.get(job.id)).toMatchObject({ status: 'queued' });
    expect(Buffer.from((await second.artifacts.read(artifact.id))?.content ?? []).toString()).toBe(
      'hello',
    );
    expect(await second.definitions.reconcile()).toMatchObject({ added: [], invalid: [] });
  });

  it('wires registered environment secrets into the shared redactor', async () => {
    const dir = await makeTempDir();
    const infra = openLocalInfrastructure({
      runtimeDir: `${dir}/runtime`,
      definitionsDir: `${dir}/definitions`,
      env: { TEST_PLATFORM_SECRET_API: 'super-secret-value' },
      logSink: () => undefined,
    });
    onCleanup(() => infra.close());
    expect(infra.redactor.redactText('x super-secret-value y')).toBe(`x ${REDACTED} y`);
  });
});
