import { afterEach, describe, expect, it } from 'vitest';
import type {
  EnvironmentSummary,
  InspectedMessage,
  InspectorMessagePage,
  InspectorSummary,
  InspectorWatch,
} from '@test-platform/contracts';
import { SECRET, cleanupAll, createTestApp, type TestApp } from './helpers.js';

afterEach(cleanupAll);

const environments = {
  environments: [
    {
      id: 'bus-test',
      name: 'Bus test',
      classification: 'TEST',
      targets: {
        bus: {
          kind: 'azureServiceBus',
          fullyQualifiedNamespace: 'example.servicebus.windows.net',
          allowedEntities: ['orders', 'events'],
          allowedOperations: ['send', 'inspect'],
        },
        sendOnly: {
          kind: 'azureServiceBus',
          fullyQualifiedNamespace: 'example.servicebus.windows.net',
          allowedEntities: ['orders'],
        },
        api: { kind: 'http', baseUrl: 'https://example.invalid', allowedPaths: ['/x'] },
      },
    },
  ],
};

const post = (t: TestApp, url: string, payload?: object) =>
  t.request({ method: 'POST', url: `/api/v1${url}`, ...(payload ? { payload } : {}) });
const get = (t: TestApp, url: string) => t.request({ url: `/api/v1${url}` });

const watchBody = { environmentId: 'bus-test', target: 'bus', entity: 'orders' };

const seed = (t: TestApp, count: number, extra: Record<string, unknown> = {}) => {
  const { inspector } = t.container.infra;
  const { watch } = inspector.addWatch({ ...watchBody, source: 'manual', createdBy: 'me' });
  inspector.storePeeked(
    watch,
    Array.from({ length: count }, (_, index) => ({
      body: new TextEncoder().encode(JSON.stringify({ n: index, ...extra })),
      sequenceNumber: String(index + 1),
      messageId: `m-${index + 1}`,
      applicationProperties: {},
    })),
  );
  return watch;
};

describe('Service Bus Inspector API', () => {
  it('registers a watch for an approved entity and is idempotent', async () => {
    const t = await createTestApp({ environments });
    const created = await post(t, '/inspector/watches', watchBody);
    expect(created.statusCode).toBe(201);
    const watch = t.json<InspectorWatch>(created);
    expect(watch).toMatchObject({
      target: 'bus',
      entity: 'orders',
      source: 'manual',
      receivedCount: 0,
    });

    const again = t.json<InspectorWatch>(await post(t, '/inspector/watches', watchBody));
    expect(again.id).toBe(watch.id);
    expect(t.json<InspectorSummary>(await get(t, '/inspector')).watches).toHaveLength(1);

    const topic = await post(t, '/inspector/watches', {
      ...watchBody,
      entity: 'events',
      subscription: 'inspector',
    });
    expect(t.json<InspectorWatch>(topic)).toMatchObject({ subscription: 'inspector' });
  });

  it('applies the Environment allowlist, including an explicit "inspect" operation', async () => {
    const t = await createTestApp({ environments });
    const refused = [
      { ...watchBody, entity: 'dead-letter' },
      { ...watchBody, target: 'sendOnly' },
      { ...watchBody, target: 'api' },
      { ...watchBody, target: 'missing' },
    ];
    for (const body of refused) {
      expect((await post(t, '/inspector/watches', body)).statusCode, JSON.stringify(body)).toBe(
        422,
      );
    }
    expect(
      (await post(t, '/inspector/watches', { ...watchBody, environmentId: 'nope' })).statusCode,
    ).toBe(422);
    expect(
      (await post(t, '/inspector/watches', { ...watchBody, subscription: 'bad name!' })).statusCode,
    ).toBe(422);
    expect((await post(t, '/inspector/watches', { ...watchBody, extra: 1 })).statusCode).toBe(400);
    expect(t.json<InspectorSummary>(await get(t, '/inspector')).watches).toEqual([]);
  });

  it('lists messages newest first, pages them, and returns full detail on request', async () => {
    const t = await createTestApp({ environments });
    seed(t, 5);
    const first = t.json<InspectorMessagePage>(await get(t, '/inspector/messages?limit=2'));
    expect(first.items.map((m) => m.messageId)).toEqual(['m-5', 'm-4']);
    expect(first).toMatchObject({ total: 5 });
    const second = t.json<InspectorMessagePage>(
      await get(t, `/inspector/messages?limit=2&before=${first.nextBefore}`),
    );
    expect(second.items.map((m) => m.messageId)).toEqual(['m-3', 'm-2']);

    const detail = t.json<InspectedMessage>(
      await get(t, `/inspector/messages/${first.items[0]!.id}`),
    );
    expect(detail).toMatchObject({
      messageId: 'm-5',
      body: { n: 4 },
      bodyEncoding: 'json',
      sequenceNumber: '5',
    });
    expect((await get(t, '/inspector/messages/does-not-exist')).statusCode).toBe(404);
    expect((await get(t, '/inspector/messages?limit=abc')).statusCode).toBe(400);
  });

  it('counts unread messages until the panel reports what it has shown', async () => {
    const t = await createTestApp({ environments });
    seed(t, 3);
    const before = t.json<InspectorSummary>(await get(t, '/inspector'));
    expect(before).toMatchObject({ unread: 3, total: 3, lastSeq: 3, lastViewedSeq: 0 });
    expect((await post(t, '/inspector/viewed', { upToSeq: before.lastSeq })).statusCode).toBe(204);
    expect(t.json<InspectorSummary>(await get(t, '/inspector'))).toMatchObject({
      unread: 0,
      lastViewedSeq: 3,
    });
    expect((await post(t, '/inspector/viewed', { upToSeq: -1 })).statusCode).toBe(400);
  });

  it('clears messages on request but keeps the watches, and removes a watch on request', async () => {
    const t = await createTestApp({ environments });
    const watch = seed(t, 2);
    expect(t.json<{ cleared: number }>(await post(t, '/inspector/clear'))).toEqual({ cleared: 2 });
    expect(t.json<InspectorSummary>(await get(t, '/inspector'))).toMatchObject({
      total: 0,
      watches: [{ id: watch.id }],
    });

    const removed = await t.request({
      method: 'DELETE',
      url: `/api/v1/inspector/watches/${watch.id}`,
    });
    expect(removed.statusCode).toBe(204);
    expect(
      (await t.request({ method: 'DELETE', url: `/api/v1/inspector/watches/${watch.id}` }))
        .statusCode,
    ).toBe(404);
  });

  it('records add, remove and clear in the audit log', async () => {
    const t = await createTestApp({ environments });
    const watch = t.json<InspectorWatch>(await post(t, '/inspector/watches', watchBody));
    await post(t, '/inspector/clear');
    await t.request({ method: 'DELETE', url: `/api/v1/inspector/watches/${watch.id}` });
    const actions = (
      t.container.infra.db
        .prepare(
          "SELECT action FROM audit_events WHERE entity_type = 'service-bus-inspector' ORDER BY id",
        )
        .all() as { action: string }[]
    ).map((row) => row.action);
    expect(actions).toEqual(['inspector.watch.add', 'inspector.clear', 'inspector.watch.remove']);
  });

  it('never returns a registered secret, even if one slipped into a stored message', async () => {
    const t = await createTestApp({ environments });
    seed(t, 1, { note: `value ${SECRET}` });
    // Simulate a message stored before the secret was known to the redactor.
    t.container.infra.db
      .prepare('UPDATE sb_inspector_messages SET preview = ?, detail = ?')
      .run(
        `value ${SECRET}`,
        JSON.stringify({ id: 'x', body: `value ${SECRET}`, applicationProperties: {} }),
      );
    const page = await get(t, '/inspector/messages');
    expect(page.body).not.toContain(SECRET);
    const [item] = t.json<InspectorMessagePage>(page).items;
    expect((await get(t, `/inspector/messages/${item!.id}`)).body).not.toContain(SECRET);
  });

  it('shows the inspector capability of Service Bus targets in the Environment summary', async () => {
    const t = await createTestApp({ environments });
    const { items } = t.json<{ items: EnvironmentSummary[] }>(await get(t, '/environments'));
    const targets = Object.fromEntries(items[0]!.targets.map((target) => [target.name, target]));
    expect(targets.bus).toMatchObject({
      serviceBus: { entities: ['orders', 'events'], canInspect: true },
    });
    expect(targets.sendOnly).toMatchObject({ serviceBus: { canInspect: false } });
    expect(targets.api!.serviceBus).toBeUndefined();
  });
});
