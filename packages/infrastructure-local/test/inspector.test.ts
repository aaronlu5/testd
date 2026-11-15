import { afterEach, describe, expect, it } from 'vitest';
import { createRedactor, type PeekedMessage } from '@test-platform/core';
import { SqliteInspectorRepository, describeBody } from '../src/index.js';
import { FakeClock, cleanupAll, openMigrated } from './helpers.js';

afterEach(cleanupAll);

const SECRET = 'sb-secret-value-0123456789';
const redactor = createRedactor({ secretValues: () => [SECRET] });

const setup = async (maxMessages?: number) => {
  const { db } = await openMigrated();
  const clock = new FakeClock();
  const repo = new SqliteInspectorRepository({ db, redactor, clock, maxMessages });
  return { db, clock, repo };
};

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const peeked = (
  sequenceNumber: string,
  body: string,
  extra: Partial<PeekedMessage> = {},
): PeekedMessage => ({
  body: text(body),
  sequenceNumber,
  applicationProperties: {},
  ...extra,
});

const watchInput = { environmentId: 'env', target: 'bus', entity: 'orders' };

describe('watches', () => {
  it('registers a watch once per entity (and per subscription)', async () => {
    const { repo } = await setup();
    const first = repo.addWatch({ ...watchInput, source: 'manual', createdBy: 'me' });
    const again = repo.addWatch({ ...watchInput, source: 'step', createdBy: 'run:1' });
    const topic = repo.addWatch({
      ...watchInput,
      subscription: 'inspector',
      source: 'manual',
      createdBy: 'me',
    });
    expect(first.created).toBe(true);
    expect(again).toMatchObject({
      created: false,
      watch: { id: first.watch.id, source: 'manual' },
    });
    expect(topic.created).toBe(true);
    expect(repo.listWatches().map((w) => w.subscription)).toEqual([undefined, 'inspector']);
  });

  it('removing a watch keeps the messages already collected', async () => {
    const { repo } = await setup();
    const { watch } = repo.addWatch({ ...watchInput, source: 'manual', createdBy: 'me' });
    repo.storePeeked(watch, [peeked('1', '{"a":1}')]);
    expect(repo.removeWatch(watch.id)).toBe(true);
    expect(repo.removeWatch(watch.id)).toBe(false);
    expect(repo.list().items).toHaveLength(1);
  });

  it('records poll outcomes without storing error text', async () => {
    const { repo } = await setup();
    const { watch } = repo.addWatch({ ...watchInput, source: 'manual', createdBy: 'me' });
    repo.recordPollFailure(watch.id, 'AUTH_FORBIDDEN');
    expect(repo.getWatch(watch.id)).toMatchObject({ lastErrorCode: 'AUTH_FORBIDDEN' });
    repo.recordPollSuccess(watch.id);
    expect(repo.getWatch(watch.id)?.lastErrorCode).toBeUndefined();
    expect(repo.getWatch(watch.id)?.lastPolledAt).toBeDefined();
  });
});

describe('collecting messages', () => {
  it('stores peeked messages once, advances the cursor, and counts them', async () => {
    const { repo } = await setup();
    const { watch } = repo.addWatch({ ...watchInput, source: 'manual', createdBy: 'me' });
    expect(repo.getCursor(watch.id)).toBeUndefined();
    expect(repo.storePeeked(watch, [peeked('5', 'a'), peeked('9223372036854775806', 'b')])).toBe(2);
    expect(repo.getCursor(watch.id)).toBe('9223372036854775806');
    // Seeing the same messages again (another worker, a restart) stores nothing.
    expect(repo.storePeeked(watch, [peeked('5', 'a')])).toBe(0);
    expect(repo.list().total).toBe(2);
    expect(repo.getWatch(watch.id)?.receivedCount).toBe(2);
  });

  it('keeps full metadata for the detail view and a short preview for lists', async () => {
    const { repo } = await setup();
    const { watch } = repo.addWatch({ ...watchInput, source: 'manual', createdBy: 'me' });
    repo.storePeeked(watch, [
      peeked('7', JSON.stringify({ orderId: 'ORD-1', note: 'x'.repeat(500) }), {
        messageId: 'm-1',
        correlationId: 'c-1',
        subject: 'order.created',
        contentType: 'application/json',
        deliveryCount: 2,
        enqueuedTime: '2026-01-01T00:00:01.000Z',
        applicationProperties: { platform_run_id: 'run-9', region: 'eu' },
      }),
    ]);
    const [summary] = repo.list().items;
    expect(summary).toMatchObject({
      origin: 'received',
      messageId: 'm-1',
      subject: 'order.created',
      entity: 'orders',
      runId: 'run-9',
    });
    expect(summary!.preview.length).toBeLessThanOrEqual(160);
    const detail = repo.get(summary!.id)!;
    expect(detail).toMatchObject({
      correlationId: 'c-1',
      deliveryCount: 2,
      sequenceNumber: '7',
      bodyEncoding: 'json',
      applicationProperties: { region: 'eu', platform_run_id: 'run-9' },
      body: { orderId: 'ORD-1' },
    });
  });

  it('records a copy of a sent message with its Run', async () => {
    const { repo } = await setup();
    await repo.recordSent({
      ...watchInput,
      messageId: 'm-2',
      correlationId: 'run-1',
      contentType: 'application/json',
      applicationProperties: { platform_run_id: 'run-1' },
      body: text('{"id":1}'),
      runId: 'run-1',
      stepRunId: 'step-1',
      nodeId: 'send',
    });
    const [message] = repo.list().items;
    expect(message).toMatchObject({ origin: 'sent', runId: 'run-1', messageId: 'm-2' });
    expect(repo.get(message!.id)).toMatchObject({
      stepRunId: 'step-1',
      nodeId: 'send',
      body: { id: 1 },
    });
  });

  it('masks secrets and credential-shaped keys before anything is stored', async () => {
    const { repo, db } = await setup();
    const { watch } = repo.addWatch({ ...watchInput, source: 'manual', createdBy: 'me' });
    repo.storePeeked(watch, [
      peeked('1', JSON.stringify({ password: 'hunter2hunter2', note: `token ${SECRET}` }), {
        applicationProperties: { apiKey: 'abcdef123456', other: SECRET },
        deadLetterReason: `failed with ${SECRET}`,
      }),
      peeked('2', `plain text with ${SECRET}`),
    ]);
    const raw = JSON.stringify(db.prepare('SELECT * FROM sb_inspector_messages').all());
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('hunter2hunter2');
    expect(raw).not.toContain('abcdef123456');
    expect(raw).toContain('***REDACTED***');
  });

  it('cuts oversized bodies and flags them; binary bodies are base64', () => {
    const big = describeBody(text('x'.repeat(300 * 1024)), 'text/plain', redactor);
    expect(big.truncated).toBe(true);
    expect(big.body).toHaveLength(256 * 1024);
    const binary = describeBody(new Uint8Array([0xff, 0xfe, 0x00, 0x01]), undefined, redactor);
    expect(binary).toMatchObject({ encoding: 'base64', body: '//4AAQ==' });
    expect(describeBody(new Uint8Array(0), undefined, redactor).encoding).toBe('empty');
  });
});

describe('listing, unread tracking, clear and retention', () => {
  it('lists newest first and pages with a cursor', async () => {
    const { repo } = await setup();
    const { watch } = repo.addWatch({ ...watchInput, source: 'manual', createdBy: 'me' });
    repo.storePeeked(
      watch,
      ['1', '2', '3', '4', '5'].map((n) => peeked(n, `m${n}`)),
    );
    const first = repo.list({ limit: 2 });
    expect(first.items.map((m) => m.preview)).toEqual(['m5', 'm4']);
    expect(first.nextBefore).toBe(first.items.at(-1)!.seq);
    const second = repo.list({ limit: 2, before: first.nextBefore });
    expect(second.items.map((m) => m.preview)).toEqual(['m3', 'm2']);
    expect(repo.list({ limit: 5, before: second.nextBefore! }).nextBefore).toBeUndefined();
  });

  it('counts unread messages until the panel marks them viewed', async () => {
    const { repo } = await setup();
    const { watch } = repo.addWatch({ ...watchInput, source: 'manual', createdBy: 'me' });
    repo.storePeeked(watch, [peeked('1', 'a'), peeked('2', 'b')]);
    expect(repo.summary()).toMatchObject({ total: 2, unread: 2, lastViewedSeq: 0 });
    repo.markViewed(repo.summary().lastSeq);
    expect(repo.summary()).toMatchObject({ unread: 0 });
    repo.storePeeked(watch, [peeked('3', 'c')]);
    expect(repo.summary()).toMatchObject({ total: 3, unread: 1 });
    // Marking an older position never moves the marker backwards.
    repo.markViewed(1);
    expect(repo.summary().unread).toBe(1);
  });

  it('keeps history until a manual clear, which leaves the watches', async () => {
    const { repo } = await setup();
    const { watch } = repo.addWatch({ ...watchInput, source: 'manual', createdBy: 'me' });
    repo.storePeeked(watch, [peeked('1', 'a'), peeked('2', 'b')]);
    expect(repo.clear()).toBe(2);
    expect(repo.list()).toMatchObject({ items: [], total: 0 });
    expect(repo.listWatches()).toHaveLength(1);
  });

  it('drops the oldest messages beyond the safety cap', async () => {
    const { repo } = await setup(3);
    const { watch } = repo.addWatch({ ...watchInput, source: 'manual', createdBy: 'me' });
    repo.storePeeked(
      watch,
      ['1', '2', '3', '4', '5'].map((n) => peeked(n, `m${n}`)),
    );
    expect(repo.list().items.map((m) => m.preview)).toEqual(['m5', 'm4', 'm3']);
    expect(repo.summary().maxMessages).toBe(3);
  });
});
