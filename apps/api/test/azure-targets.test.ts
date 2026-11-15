import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EnvironmentConfig, TestDefinition } from '@test-platform/contracts';
import { createBuiltInRegistry } from '@test-platform/step-sdk';
import {
  checkEnvironmentPolicy,
  checkStepConfigurations,
} from '../src/services/validation-service.js';
import { EnvironmentService } from '../src/services/environment-service.js';

const environment: EnvironmentConfig = {
  id: 'orders-test',
  name: 'Orders',
  classification: 'TEST',
  targets: {
    api: { kind: 'http', baseUrl: 'https://example.azure-api.net', allowedPaths: ['/orders/*'] },
    storage: {
      kind: 'azureBlob',
      accountUrl: 'https://example.blob.core.windows.net',
      allowedContainers: ['inbound-orders'],
    },
    events: {
      kind: 'azureServiceBus',
      fullyQualifiedNamespace: 'example.servicebus.windows.net',
      allowedEntities: ['order-events'],
    },
  },
};

const testWith = (nodes: { id: string; type: string; parameters: Record<string, unknown> }[]) =>
  ({
    schemaVersion: 2,
    id: 't',
    version: 1,
    name: 't',
    tags: [],
    variables: {},
    metadata: { createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'tester' },
    nodes: nodes.map((node) => ({ ...node, name: node.id })),
    edges: [],
  }) as unknown as TestDefinition;

describe('target Steps in Test validation', () => {
  it('accepts policy-conformant literal parameters', () => {
    const test = testWith([
      { id: 'a', type: 'http.request', parameters: { target: 'api', path: '/orders/1' } },
      {
        id: 'b',
        type: 'blob.upload',
        parameters: {
          target: 'storage',
          container: 'inbound-orders',
          blobName: 'a.json',
          content: {},
        },
      },
      {
        id: 'c',
        type: 'serviceBus.send',
        parameters: { target: 'events', entity: 'order-events', body: 'x' },
      },
    ]);
    expect(checkEnvironmentPolicy(test, environment)).toEqual([]);
    expect(checkStepConfigurations(test, createBuiltInRegistry())).toEqual([]);
  });

  it('reports allowlist violations at the offending node before any Run exists', () => {
    const test = testWith([
      { id: 'a', type: 'http.request', parameters: { target: 'api', path: '/admin' } },
      {
        id: 'b',
        type: 'blob.download',
        parameters: { target: 'storage', container: 'other', blobName: 'a.json' },
      },
      {
        id: 'c',
        type: 'serviceBus.send',
        parameters: { target: 'events', entity: 'dead-letter', body: 'x' },
      },
      {
        id: 'd',
        type: 'waitForCondition',
        parameters: { probe: 'http', target: 'api', path: '/orders/1/../../x' },
      },
    ]);
    const issues = checkEnvironmentPolicy(test, environment);
    expect(issues.map((issue) => issue.path)).toEqual([
      '/nodes/0/parameters',
      '/nodes/1/parameters',
      '/nodes/2/parameters',
      '/nodes/3/parameters',
    ]);
    expect(issues.every((issue) => issue.keyword === 'target-policy')).toBe(true);
  });

  it('defers parameters that still contain expressions to the worker', () => {
    const test = testWith([
      {
        id: 'a',
        type: 'http.request',
        parameters: { target: 'api', path: '/admin/{{variables.id}}' },
      },
    ]);
    expect(checkEnvironmentPolicy(test, environment)).toEqual([]);
  });

  it('still refuses raw URLs and connection strings as parameters', () => {
    const test = testWith([
      {
        id: 'a',
        type: 'http.request',
        parameters: { target: 'api', path: '/orders/1', url: 'https://evil.example' },
      },
    ]);
    expect(checkEnvironmentPolicy(test, environment).length).toBeGreaterThan(0);
  });
});

describe('Environment configuration safety', () => {
  const load = async (content: unknown) => {
    const dir = await mkdtemp(join(tmpdir(), 'tp-env-'));
    try {
      const file = join(dir, 'environments.json');
      await writeFile(file, JSON.stringify(content));
      return await new EnvironmentService(file).check();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  it('loads a safe Azure Environment', async () => {
    expect(await load({ environments: [environment] })).toBe(true);
  });

  it('refuses a target with embedded credentials or a SAS token', async () => {
    const withSas = {
      ...environment,
      targets: {
        storage: {
          kind: 'azureBlob',
          accountUrl: 'https://example.blob.core.windows.net/?sv=2024&sig=abc',
          allowedContainers: ['inbound-orders'],
        },
      },
    };
    expect(await load({ environments: [withSas] })).toBe(false);
    const insecure = {
      ...environment,
      targets: { api: { kind: 'http', baseUrl: 'http://api.example.com', allowedPaths: ['/x'] } },
    };
    expect(await load({ environments: [insecure] })).toBe(false);
  });
});
