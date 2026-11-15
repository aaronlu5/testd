import { afterEach, describe, expect, it } from 'vitest';
import type { MockSetupAsset } from '@test-platform/contracts';
import {
  cleanupAll,
  createHarness,
  createTestRegistry,
  makeRun,
  newTestState,
  node,
  submit,
} from './helpers.js';

afterEach(cleanupAll);

const setup: MockSetupAsset = {
  schemaVersion: 1,
  id: 'setup-1',
  version: 1,
  name: 'Gateway',
  tags: [],
  metadata: { createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'tester' },
  rules: [{ path: '/ping', method: 'GET', status: 200, body: { pong: true } }],
};

describe('Mock API setups during a Run', () => {
  it('serves the Run snapshot setups while it executes and stops when it ends', async () => {
    const seen: (string | undefined)[] = [];
    const registry = createTestRegistry(newTestState());
    const holder: { harness?: Awaited<ReturnType<typeof createHarness>> } = {};
    registry.register({
      type: 'probe',
      displayName: 'probe',
      configSchema: { type: 'object' },
      sensitivePaths: [],
      defaults: {},
      capabilities: { external: false, supportsRetry: false, supportsArtifacts: false },
      validate: () => [],
      async execute() {
        seen.push(holder.harness?.container.mocks.match('GET', '/ping')?.body);
        return { status: 'Succeeded', logs: [], output: {} };
      },
    } as never);
    const harness = await createHarness({ registry });
    holder.harness = harness;

    const run = makeRun([node('look', 'probe', {})]);
    run.snapshots.mockSetups = [setup];
    await submit(harness.container, run);
    expect(await harness.container.loop.runOnce()).toBe(true);

    expect(seen).toEqual(['{"pong":true}']);
    expect(await harness.container.infra.runs.getRun(run.id)).toMatchObject({
      status: 'Succeeded',
    });
    expect(harness.container.mocks.activeRuns).toEqual([]);
    expect(harness.container.mocks.match('GET', '/ping')).toBeUndefined();
  });
});
