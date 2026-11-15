import { describe, expect, it } from 'vitest';
import type { EnvironmentConfig } from '@test-platform/contracts';
import {
  PlatformError,
  assertBlobName,
  assertConnectionStringMatches,
  serviceBusNamespaceHost,
  assertRelativePath,
  assertRequestHeaders,
  createTargetPolicy,
  isRetryableCode,
  mapTargetFailure,
  matchesGlob,
  validateEnvironmentTargets,
} from '../src/index.js';

const environment: Pick<EnvironmentConfig, 'id' | 'targets'> = {
  id: 'orders-test',
  targets: {
    api: {
      kind: 'http',
      baseUrl: 'https://example.azure-api.net/gateway',
      allowedPaths: ['/orders/*', '/health'],
      allowedMethods: ['GET', 'POST'],
      authentication: { type: 'secretReference', provider: 'keyVault', name: 'orders-api-key' },
    },
    legacy: {
      kind: 'http',
      baseUrl: 'https://legacy.example.com',
      allowedPaths: ['/**'],
      secretRef: 'legacy-key',
    },
    storage: {
      kind: 'azureBlob',
      accountUrl: 'https://example.blob.core.windows.net',
      allowedContainers: ['inbound-orders'],
      allowedOperations: ['upload'],
      allowedBlobPrefixes: ['runs/'],
    },
    bus: {
      kind: 'azureServiceBus',
      fullyQualifiedNamespace: 'example.servicebus.windows.net',
      allowedEntities: ['order-events'],
    },
    shortBus: { kind: 'azureServiceBus', namespace: 'tiny', allowedEntities: ['q'] },
  },
};

const policy = createTargetPolicy(environment);

const code = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    return error instanceof PlatformError ? error.code : 'OTHER';
  }
  return 'NO_ERROR';
};

describe('glob matching', () => {
  it('lets * stay within a segment and ** cross segments', () => {
    expect(matchesGlob('/orders/*', '/orders/42')).toBe(true);
    expect(matchesGlob('/orders/*', '/orders/42/items')).toBe(false);
    expect(matchesGlob('/orders/**', '/orders/42/items')).toBe(true);
    expect(matchesGlob('/health', '/health')).toBe(true);
    expect(matchesGlob('/health', '/healthz')).toBe(false);
    expect(matchesGlob('/a.b', '/aXb')).toBe(false);
  });
});

describe('relative paths', () => {
  it.each([
    'https://evil.example/x',
    '//evil.example/x',
    'orders/1',
    '/orders/../admin',
    '/orders/./1',
    '/orders/%2e%2e/admin',
    '/orders/%2E%2E%2Fadmin',
    '/orders\\1',
    '/orders/1?x=1',
    '/orders/1#frag',
    '/orders/\u0000',
  ])('rejects %j', (path) => {
    expect(code(() => assertRelativePath(path))).toBe('VALIDATION_TARGET_POLICY');
  });

  it('accepts plain paths', () => {
    expect(code(() => assertRelativePath('/orders/42/lines'))).toBe('NO_ERROR');
  });
});

describe('HTTP policy', () => {
  it('builds a URL on the configured origin and base path', () => {
    const plan = policy.http('api', {
      method: 'get',
      path: '/orders/42',
      query: { a: 1, b: 'x y' },
    });
    expect(plan.url).toBe('https://example.azure-api.net/gateway/orders/42?a=1&b=x+y');
    expect(plan.method).toBe('GET');
    expect(plan.authentication?.name).toBe('orders-api-key');
    expect(plan.correlationHeaders).toBe(true);
  });

  it('treats the Phase 1 secretRef as a localPlainText reference', () => {
    const plan = policy.http('legacy', { method: 'GET', path: '/anything/at/all' });
    expect(plan.authentication).toEqual({
      type: 'secretReference',
      provider: 'localPlainText',
      name: 'legacy-key',
    });
  });

  it('refuses methods, paths and targets outside the Environment', () => {
    expect(code(() => policy.http('api', { method: 'DELETE', path: '/orders/1' }))).toBe(
      'VALIDATION_TARGET_POLICY',
    );
    expect(code(() => policy.http('api', { method: 'GET', path: '/admin' }))).toBe(
      'VALIDATION_TARGET_POLICY',
    );
    expect(code(() => policy.http('api', { method: 'GET', path: '/orders/1/2' }))).toBe(
      'VALIDATION_TARGET_POLICY',
    );
    expect(code(() => policy.http('missing', { method: 'GET', path: '/health' }))).toBe(
      'VALIDATION_TARGET_POLICY',
    );
    expect(code(() => policy.http('storage', { method: 'GET', path: '/health' }))).toBe(
      'VALIDATION_TARGET_POLICY',
    );
  });

  it('never allows DELETE unless a target names it', () => {
    expect(code(() => policy.http('legacy', { method: 'DELETE', path: '/x' }))).toBe(
      'VALIDATION_TARGET_POLICY',
    );
    expect(code(() => policy.http('legacy', { method: 'PATCH', path: '/x' }))).toBe('NO_ERROR');
  });

  it('rejects request headers that carry credentials or framing', () => {
    expect(code(() => assertRequestHeaders({ Authorization: 'x' }))).toBe(
      'VALIDATION_TARGET_POLICY',
    );
    expect(code(() => assertRequestHeaders({ 'Ocp-Apim-Subscription-Key': 'x' }))).toBe(
      'VALIDATION_TARGET_POLICY',
    );
    expect(code(() => assertRequestHeaders({ 'X-Test-Platform-Run-Id': 'spoof' }))).toBe(
      'VALIDATION_TARGET_POLICY',
    );
    expect(code(() => assertRequestHeaders({ 'x-ok': 'a\r\nInjected: 1' }))).toBe(
      'VALIDATION_TARGET_POLICY',
    );
    expect(code(() => assertRequestHeaders({ 'X-Api-Key': 'literal' }))).toBe(
      'VALIDATION_TARGET_POLICY',
    );
    expect(code(() => assertRequestHeaders({ 'X-Session-Token': 'literal' }))).toBe(
      'VALIDATION_TARGET_POLICY',
    );
    expect(code(() => assertRequestHeaders({ Accept: 'application/json' }))).toBe('NO_ERROR');
  });
});

describe('Blob policy', () => {
  const ok = {
    operation: 'upload',
    container: 'inbound-orders',
    blobName: 'runs/1/a.json',
  } as const;

  it('allows an approved container, operation and prefix', () => {
    const plan = policy.blob('storage', ok);
    expect(plan.accountHost).toBe('example.blob.core.windows.net');
  });

  it('refuses other containers, operations, prefixes and malformed names', () => {
    expect(code(() => policy.blob('storage', { ...ok, container: 'other' }))).toBe(
      'VALIDATION_TARGET_POLICY',
    );
    expect(code(() => policy.blob('storage', { ...ok, operation: 'download' }))).toBe(
      'VALIDATION_TARGET_POLICY',
    );
    expect(code(() => policy.blob('storage', { ...ok, blobName: 'other/a.json' }))).toBe(
      'VALIDATION_TARGET_POLICY',
    );
    expect(code(() => policy.blob('storage', { ...ok, blobName: 'runs/../x' }))).toBe(
      'VALIDATION_TARGET_POLICY',
    );
    expect(code(() => assertBlobName('/leading'))).toBe('VALIDATION_TARGET_POLICY');
    expect(code(() => assertBlobName('a//b'))).toBe('VALIDATION_TARGET_POLICY');
    expect(code(() => assertBlobName('a/b.json'))).toBe('NO_ERROR');
  });
});

describe('Service Bus policy', () => {
  it('allows listed entities and normalizes the namespace', () => {
    expect(policy.serviceBus('bus', { entity: 'order-events' }).fullyQualifiedNamespace).toBe(
      'example.servicebus.windows.net',
    );
    expect(policy.serviceBus('shortBus', { entity: 'q' }).fullyQualifiedNamespace).toBe(
      'tiny.servicebus.windows.net',
    );
  });

  it('keeps localhost as the emulator host instead of expanding it to an Azure namespace', () => {
    expect(
      serviceBusNamespaceHost({
        kind: 'azureServiceBus',
        fullyQualifiedNamespace: 'localhost',
      } as never),
    ).toBe('localhost');
  });

  it('never implies the inspect operation, even though send is the default', () => {
    expect(
      code(() => policy.serviceBus('bus', { entity: 'order-events', operation: 'inspect' })),
    ).toBe('VALIDATION_TARGET_POLICY');
    const inspecting = createTargetPolicy({
      id: 'e',
      targets: {
        bus: {
          kind: 'azureServiceBus',
          fullyQualifiedNamespace: 'example.servicebus.windows.net',
          allowedEntities: ['order-events'],
          allowedOperations: ['inspect'],
        },
      },
    });
    expect(
      code(() => inspecting.serviceBus('bus', { entity: 'order-events', operation: 'inspect' })),
    ).toBe('NO_ERROR');
    // Listing only "inspect" does not grant "send".
    expect(code(() => inspecting.serviceBus('bus', { entity: 'order-events' }))).toBe(
      'VALIDATION_TARGET_POLICY',
    );
  });

  it('refuses unlisted entities', () => {
    expect(code(() => policy.serviceBus('bus', { entity: 'dead-letter' }))).toBe(
      'VALIDATION_TARGET_POLICY',
    );
  });
});

describe('connection-string binding', () => {
  const sb =
    'Endpoint=sb://example.servicebus.windows.net/;SharedAccessKeyName=s;SharedAccessKey=abc123abc123';

  it('accepts a connection string for the configured host', () => {
    expect(
      code(() =>
        assertConnectionStringMatches('azureServiceBus', sb, 'example.servicebus.windows.net'),
      ),
    ).toBe('NO_ERROR');
  });

  it('refuses another host without echoing any part of the secret', () => {
    try {
      assertConnectionStringMatches('azureServiceBus', sb, 'other.servicebus.windows.net');
      expect.unreachable();
    } catch (error) {
      expect((error as PlatformError).code).toBe('VALIDATION_TARGET_POLICY');
      expect((error as Error).message).not.toContain('abc123');
      expect((error as Error).message).not.toContain('example.servicebus');
    }
  });

  it('binds blob connection strings by BlobEndpoint or account name', () => {
    const byEndpoint =
      'DefaultEndpointsProtocol=https;AccountName=example;AccountKey=a2V5a2V5a2V5;BlobEndpoint=https://example.blob.core.windows.net/';
    const byName = 'DefaultEndpointsProtocol=https;AccountName=example;AccountKey=a2V5a2V5a2V5';
    expect(
      code(() =>
        assertConnectionStringMatches('azureBlob', byEndpoint, 'example.blob.core.windows.net'),
      ),
    ).toBe('NO_ERROR');
    expect(
      code(() =>
        assertConnectionStringMatches('azureBlob', byName, 'example.blob.core.windows.net'),
      ),
    ).toBe('NO_ERROR');
    expect(
      code(() => assertConnectionStringMatches('azureBlob', byName, 'other.blob.core.windows.net')),
    ).toBe('VALIDATION_TARGET_POLICY');
  });
});

describe('target configuration validation', () => {
  it('accepts the example Environment', () => {
    expect(validateEnvironmentTargets(environment)).toEqual([]);
  });

  it('flags insecure or secret-bearing URLs and bad allowlists', () => {
    const issues = validateEnvironmentTargets({
      targets: {
        a: { kind: 'http', baseUrl: 'http://api.example.com', allowedPaths: ['/x'] },
        b: { kind: 'http', baseUrl: 'https://u:p@api.example.com', allowedPaths: ['/x'] },
        c: {
          kind: 'azureBlob',
          accountUrl: 'https://x.blob.core.windows.net/?sv=1&sig=abc',
          allowedContainers: ['Bad_Name'],
        },
        d: {
          kind: 'azureServiceBus',
          fullyQualifiedNamespace: 'x.servicebus.windows.net',
          allowedEntities: [],
        },
        e: {
          kind: 'http',
          baseUrl: 'https://api.example.com',
          allowedPaths: ['/a/../b'],
          allowedMethods: ['TRACE'],
        },
        f: {
          kind: 'azureServiceBus',
          fullyQualifiedNamespace: 'x.servicebus.windows.net',
          allowedEntities: ['q'],
          credential: {
            type: 'secretReference',
            provider: 'localPlainText',
            name: 'n',
            usage: 'apiKey',
          },
        },
      },
    });
    const paths = issues.map((item) => item.path);
    expect(paths).toContain('/targets/a/baseUrl');
    expect(paths).toContain('/targets/b/baseUrl');
    expect(paths).toContain('/targets/c/accountUrl');
    expect(paths).toContain('/targets/c/allowedContainers/0');
    expect(paths).toContain('/targets/d/allowedEntities');
    expect(paths).toContain('/targets/e/allowedPaths/0');
    expect(paths).toContain('/targets/e/allowedMethods/0');
    expect(paths).toContain('/targets/f/credential/usage');
  });

  it('allows http only on loopback (for local emulators)', () => {
    expect(
      validateEnvironmentTargets({
        targets: {
          a: { kind: 'http', baseUrl: 'http://localhost:8080', allowedPaths: ['/x'] },
          b: {
            kind: 'azureBlob',
            accountUrl: 'http://127.0.0.1:10000/devstoreaccount1',
            allowedContainers: ['test-box'],
          },
        },
      }),
    ).toEqual([]);
  });
});

describe('mapTargetFailure', () => {
  const secret = 'SharedAccessKey=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==';

  it('never copies SDK message text', () => {
    const mapped = mapTargetFailure(
      Object.assign(new Error(`GET https://x/?sig=abc failed. ${secret}`), {
        statusCode: 503,
        code: 'ServerBusy',
      }),
      'Blob upload',
    );
    expect(mapped.message).not.toContain('abc');
    expect(mapped.message).not.toContain('SharedAccessKey');
    expect(mapped.code).toBe('TARGET_SERVICE');
    expect(mapped.detail).toBe('status=503; code=ServerBusy');
  });

  it.each([
    [{ statusCode: 401 }, 'AUTH_CREDENTIAL', false],
    [{ statusCode: 403 }, 'AUTH_FORBIDDEN', false],
    [{ statusCode: 404 }, 'TARGET_REQUEST', false],
    [{ statusCode: 408 }, 'TARGET_TIMEOUT', true],
    [{ statusCode: 429 }, 'TARGET_SERVICE', true],
    [{ statusCode: 500 }, 'TARGET_SERVICE', true],
    [{ code: 'ETIMEDOUT' }, 'TARGET_TIMEOUT', true],
    [{ code: 'ECONNRESET' }, 'TARGET_SERVICE', true],
    [{ code: 'ServiceTimeout' }, 'TARGET_TIMEOUT', true],
    [{ code: 'MessageTooLargeError' }, 'TARGET_REQUEST', false],
    [{ name: 'CredentialUnavailableError' }, 'AUTH_CREDENTIAL', false],
    [{ name: 'AbortError' }, 'EXECUTION_CANCELLED', false],
    [{}, 'TARGET_REQUEST', false],
  ] as const)('classifies %j as %s (retryable=%s)', (input, expected, retryable) => {
    const mapped = mapTargetFailure(Object.assign(new Error('boom'), input), 'Operation');
    expect(mapped.code).toBe(expected);
    expect(isRetryableCode(mapped.code)).toBe(retryable);
  });

  it('keeps only token-shaped codes', () => {
    const mapped = mapTargetFailure({ code: 'has spaces and Key=secret' }, 'Operation');
    expect(mapped.detail).toBeUndefined();
  });

  it('passes PlatformError through unchanged', () => {
    const original = new PlatformError('AUTH_SECRET_UNAVAILABLE', 'missing');
    expect(mapTargetFailure(original, 'Operation')).toBe(original);
  });
});

describe('secret provider policy by classification', () => {
  const keyVault = {
    type: 'secretReference',
    provider: 'keyVault',
    name: 'orders-api-key',
  } as const;
  const plain = {
    type: 'secretReference',
    provider: 'localPlainText',
    name: 'orders-api-key',
  } as const;
  const make = (classification: string, authentication: typeof keyVault | typeof plain) => ({
    classification,
    targets: {
      api: {
        kind: 'http' as const,
        baseUrl: 'https://example.azure-api.net',
        allowedPaths: ['/x'],
        authentication,
      },
      bus: {
        kind: 'azureServiceBus' as const,
        fullyQualifiedNamespace: 'example.servicebus.windows.net',
        allowedEntities: ['q'],
        credential: authentication,
      },
    },
  });

  it('allows plain-text references for LOCAL and TEST Environments', () => {
    expect(validateEnvironmentTargets(make('LOCAL', plain))).toEqual([]);
    expect(validateEnvironmentTargets(make('TEST', plain))).toEqual([]);
  });

  it('requires Key Vault references for STAGING and PRODUCTION', () => {
    for (const classification of ['STAGING', 'PRODUCTION']) {
      expect(validateEnvironmentTargets(make(classification, keyVault))).toEqual([]);
      const paths = validateEnvironmentTargets(make(classification, plain)).map((i) => i.path);
      expect(paths).toEqual([
        '/targets/api/authentication/provider',
        '/targets/bus/credential/provider',
      ]);
    }
  });

  it('treats the Phase 1 secretRef (always plain text) the same way', () => {
    const issues = validateEnvironmentTargets({
      classification: 'PRODUCTION',
      targets: {
        api: {
          kind: 'http',
          baseUrl: 'https://a.example.com',
          allowedPaths: ['/x'],
          secretRef: 'k',
        },
      },
    });
    expect(issues.map((i) => i.path)).toEqual(['/targets/api/secretRef']);
  });
});
