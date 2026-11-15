import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EnvironmentConfig } from '@test-platform/contracts';
import type { PeekedMessage, ServiceBusConnection, TargetClients } from '@test-platform/core';
import {
  cleanupAll,
  createHarness,
  environment,
  makeRun,
  node,
  stepRuns,
  submit,
} from './helpers.js';

afterEach(cleanupAll);

// Test-only values, shaped like real credentials so masking is exercised.
const SB_KEY = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==';
const SB_CONNECTION = `Endpoint=sb://example.servicebus.windows.net/;SharedAccessKeyName=listen;SharedAccessKey=${SB_KEY}`;
const env = { TEST_PLATFORM_SECRET_ORDERS_SB_CONNECTION: SB_CONNECTION };

const sbEnvironment = (
  operations: ('send' | 'inspect')[] = ['send', 'inspect'],
): EnvironmentConfig =>
  environment({
    targets: {
      bus: {
        kind: 'azureServiceBus',
        fullyQualifiedNamespace: 'example.servicebus.windows.net',
        allowedEntities: ['orders', 'events'],
        allowedOperations: operations,
        credential: {
          type: 'secretReference',
          provider: 'localPlainText',
          name: 'orders-sb-connection',
          usage: 'connectionString',
        },
      },
    },
  });

type PeekCall = {
  entity: string;
  subscription?: string;
  fromSequenceNumber?: string;
  maxMessages: number;
};

/** A Service Bus double that only knows how to peek; send/receive would be a test failure. */
const fakeBus = (queue: Map<string, PeekedMessage[]>) => {
  const state = {
    peeks: [] as PeekCall[],
    opened: [] as ServiceBusConnection[],
    closed: 0,
    failWith: undefined as unknown,
  };
  const clients: TargetClients = {
    http: { send: () => Promise.reject(new Error('http is not used')) },
    openBlob: () => {
      throw new Error('blob is not used');
    },
    openSql: () => {
      throw new Error('sql is not available in tests');
    },
    openServiceBus: (connection) => {
      state.opened.push(connection);
      return {
        send: () => Promise.reject(new Error('the inspector must never send')),
        peek: (input) => {
          state.peeks.push({
            entity: input.entity,
            ...(input.subscription ? { subscription: input.subscription } : {}),
            ...(input.fromSequenceNumber ? { fromSequenceNumber: input.fromSequenceNumber } : {}),
            maxMessages: input.maxMessages,
          });
          if (state.failWith) return Promise.reject(state.failWith);
          const from = input.fromSequenceNumber ? BigInt(input.fromSequenceNumber) : 0n;
          const key = `${input.entity}/${input.subscription ?? ''}`;
          return Promise.resolve(
            (queue.get(key) ?? [])
              .filter((message) => BigInt(message.sequenceNumber) >= from)
              .slice(0, input.maxMessages),
          );
        },
        close: () => {
          state.closed += 1;
          return Promise.resolve();
        },
      };
    },
  };
  return { clients, state };
};

const message = (
  sequenceNumber: string,
  body: unknown,
  extra: Partial<PeekedMessage> = {},
): PeekedMessage => ({
  body: new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)),
  sequenceNumber,
  applicationProperties: {},
  ...extra,
});

const writeEnvironments = async (dir: string, environments: EnvironmentConfig[]): Promise<void> => {
  const file = join(dir, 'config', 'environments.local.json');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ environments }));
};

const watchInput = { environmentId: 'local-test', target: 'bus', entity: 'orders' };

describe('Service Bus Inspector worker', () => {
  it('peeks a watched queue, stores what it sees, and only asks for newer messages afterwards', async () => {
    const queue = new Map([
      [
        'orders/',
        [message('10', { orderId: 'A', password: 'hunter2hunter2' }), message('11', 'second')],
      ],
    ]);
    const bus = fakeBus(queue);
    const h = await createHarness({ env, targetClients: bus.clients });
    await writeEnvironments(h.dir, [sbEnvironment()]);
    h.container.infra.inspector.addWatch({ ...watchInput, source: 'manual', createdBy: 'me' });

    expect(await h.container.inspector.tick()).toBe(2);
    expect(bus.state.peeks[0]).toEqual({ entity: 'orders', maxMessages: 50 });
    // The credential reached the client (in memory only) and the client was closed straight away.
    expect(bus.state.opened[0]).toEqual({
      fullyQualifiedNamespace: 'example.servicebus.windows.net',
      connectionString: SB_CONNECTION,
    });
    expect(bus.state.closed).toBe(1);

    queue.get('orders/')!.push(message('12', 'third'));
    expect(await h.container.inspector.tick()).toBe(1);
    expect(bus.state.peeks.at(-1)).toMatchObject({ fromSequenceNumber: '12' });
    expect(h.container.infra.inspector.list().items.map((m) => m.preview)).toEqual([
      'third',
      'second',
      expect.stringContaining('orderId'),
    ]);

    const everything = JSON.stringify([
      h.container.infra.db.prepare('SELECT * FROM sb_inspector_messages').all(),
      h.container.infra.db.prepare('SELECT * FROM sb_inspector_watches').all(),
      h.logs,
    ]);
    for (const secret of [SB_CONNECTION, SB_KEY, 'hunter2hunter2'])
      expect(everything).not.toContain(secret);
    expect(
      h.container.infra.inspector.getWatch(h.container.infra.inspector.listWatches()[0]!.id),
    ).toMatchObject({
      receivedCount: 3,
    });
  });

  it('peeks a topic subscription when one is named', async () => {
    const bus = fakeBus(new Map([['events/inspector', [message('1', 'hello')]]]));
    const h = await createHarness({ env, targetClients: bus.clients });
    await writeEnvironments(h.dir, [sbEnvironment()]);
    h.container.infra.inspector.addWatch({
      ...watchInput,
      entity: 'events',
      subscription: 'inspector',
      source: 'manual',
      createdBy: 'me',
    });
    expect(await h.container.inspector.tick()).toBe(1);
    expect(bus.state.peeks[0]).toMatchObject({ entity: 'events', subscription: 'inspector' });
  });

  it('refuses a target that does not allow "inspect", without contacting Service Bus', async () => {
    const bus = fakeBus(new Map());
    const h = await createHarness({ env, targetClients: bus.clients });
    await writeEnvironments(h.dir, [sbEnvironment(['send'])]);
    const { watch } = h.container.infra.inspector.addWatch({
      ...watchInput,
      source: 'step',
      createdBy: 'run:1',
    });
    await h.container.inspector.tick();
    expect(bus.state.opened).toHaveLength(0);
    expect(h.container.infra.inspector.getWatch(watch.id)).toMatchObject({
      lastErrorCode: 'VALIDATION_TARGET_POLICY',
    });
  });

  it('reports a missing Environment and backs off instead of hammering the target', async () => {
    const bus = fakeBus(new Map());
    const h = await createHarness({ env, targetClients: bus.clients });
    await writeEnvironments(h.dir, []);
    const { watch } = h.container.infra.inspector.addWatch({
      ...watchInput,
      source: 'manual',
      createdBy: 'me',
    });
    await h.container.inspector.tick();
    expect(h.container.infra.inspector.getWatch(watch.id)?.lastErrorCode).toBe(
      'VALIDATION_REFERENCE',
    );

    await writeEnvironments(h.dir, [sbEnvironment()]);
    await h.container.inspector.tick(); // still inside the failure back-off window
    expect(bus.state.opened).toHaveLength(0);
  });

  it('turns SDK failures into a code only; the message text is never stored or logged', async () => {
    const bus = fakeBus(new Map());
    bus.state.failWith = Object.assign(new Error(`bad credentials ${SB_CONNECTION}`), {
      code: 'UnauthorizedError',
    });
    const h = await createHarness({ env, targetClients: bus.clients });
    await writeEnvironments(h.dir, [sbEnvironment()]);
    const { watch } = h.container.infra.inspector.addWatch({
      ...watchInput,
      source: 'manual',
      createdBy: 'me',
    });
    await h.container.inspector.tick();
    expect(h.container.infra.inspector.getWatch(watch.id)).toMatchObject({
      lastErrorCode: 'AUTH_FORBIDDEN',
    });
    expect(bus.state.closed).toBe(1);
    const stored = JSON.stringify([
      h.container.infra.db.prepare('SELECT * FROM sb_inspector_watches').all(),
      h.logs,
    ]);
    expect(stored).not.toContain(SB_KEY);
    expect(stored).not.toContain('bad credentials');
  });

  it('refuses a connection string that points at another namespace', async () => {
    const bus = fakeBus(new Map());
    const h = await createHarness({
      env: {
        TEST_PLATFORM_SECRET_ORDERS_SB_CONNECTION: SB_CONNECTION.replace('example.', 'other.'),
      },
      targetClients: bus.clients,
    });
    await writeEnvironments(h.dir, [sbEnvironment()]);
    const { watch } = h.container.infra.inspector.addWatch({
      ...watchInput,
      source: 'manual',
      createdBy: 'me',
    });
    await h.container.inspector.tick();
    expect(bus.state.opened).toHaveLength(0);
    expect(h.container.infra.inspector.getWatch(watch.id)?.lastErrorCode).toBe(
      'VALIDATION_TARGET_POLICY',
    );
  });

  it('is fed by a Service Bus Step that asks to be inspected (copy recorded, entity registered)', async () => {
    const bus = fakeBus(new Map());
    const h = await createHarness({ env, targetClients: bus.clients });
    const sent: unknown[] = [];
    const original = bus.clients.openServiceBus;
    bus.clients.openServiceBus = (connection) => {
      const port = original(connection);
      return { ...port, send: (input) => (sent.push(input.message), Promise.resolve()) };
    };
    const run = makeRun(
      [
        node('send', 'serviceBus.send', {
          target: 'bus',
          entity: 'orders',
          body: { orderId: 'A-1', token: 'abcdefgh12345678' },
          duplicateDetection: true,
          inspect: true,
        }),
      ],
      { environment: sbEnvironment() },
    );
    await submit(h.container, run);
    await h.container.loop.runOnce();

    expect((await h.container.infra.runs.getRun(run.id))?.status).toBe('Succeeded');
    expect(sent).toHaveLength(1);
    const watches = h.container.infra.inspector.listWatches();
    expect(watches).toMatchObject([
      { target: 'bus', entity: 'orders', source: 'step', environmentId: 'local-test' },
    ]);
    const [copy] = h.container.infra.inspector.list().items;
    expect(copy).toMatchObject({ origin: 'sent', runId: run.id, entity: 'orders' });
    expect(h.container.infra.inspector.get(copy!.id)).toMatchObject({
      body: { orderId: 'A-1' },
      nodeId: 'send',
    });
    const [step] = await stepRuns(h.container, run.id);
    expect(step?.outputPreview).toMatchObject({ inspector: 'registered' });
    expect(
      JSON.stringify(
        h.container.infra.db.prepare('SELECT detail FROM sb_inspector_messages').all(),
      ),
    ).not.toContain('abcdefgh12345678');
  });
});
