import { describe, expect, it } from 'vitest';
import { PlatformError } from '@test-platform/core';
import { createFetchHttpTransport, createTargetClients } from '../src/index.js';

const request = (
  overrides: Partial<Parameters<ReturnType<typeof createFetchHttpTransport>['send']>[0]> = {},
) => ({
  method: 'GET',
  url: 'https://example.azure-api.net/orders/1',
  headers: { accept: 'application/json' },
  signal: new AbortController().signal,
  timeoutMs: 1000,
  maxResponseBytes: 1024,
  ...overrides,
});

const stream = (chunks: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });

const thrown = async (work: () => Promise<unknown>): Promise<PlatformError> => {
  try {
    await work();
  } catch (error) {
    return error as PlatformError;
  }
  throw new Error('expected the call to throw');
};

describe('fetch HTTP transport', () => {
  it('does not follow redirects and lower-cases header names', async () => {
    let init: RequestInit | undefined;
    const transport = createFetchHttpTransport(((_url: string, options: RequestInit) => {
      init = options;
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { Location: 'https://evil.example/', 'X-Req': '1' },
        }),
      );
    }) as unknown as typeof fetch);
    const response = await transport.send(request());
    expect(init?.redirect).toBe('manual');
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('https://evil.example/');
    expect(response.headers['x-req']).toBe('1');
  });

  it('reads at most maxResponseBytes and reports truncation', async () => {
    const transport = createFetchHttpTransport((() =>
      Promise.resolve(
        new Response(stream(['a'.repeat(600), 'b'.repeat(600)]), { status: 200 }),
      )) as unknown as typeof fetch);
    const response = await transport.send(request({ maxResponseBytes: 1000 }));
    expect(response.body.byteLength).toBe(1000);
    expect(response.truncated).toBe(true);
    const whole = await transport.send(request({ maxResponseBytes: 5000 }));
    expect(whole.body.byteLength).toBe(1200);
    expect(whole.truncated).toBe(false);
  });

  it('sends the body and method it is given', async () => {
    let init: RequestInit | undefined;
    const transport = createFetchHttpTransport(((_url: string, options: RequestInit) => {
      init = options;
      return Promise.resolve(new Response('ok'));
    }) as unknown as typeof fetch);
    await transport.send(request({ method: 'POST', body: new TextEncoder().encode('{"a":1}') }));
    expect(init?.method).toBe('POST');
    expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe('{"a":1}');
  });

  it('reports a timeout as TARGET_TIMEOUT and a caller abort as cancellation', async () => {
    const hanging = ((_url: string, options: RequestInit) =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      })) as unknown as typeof fetch;
    const transport = createFetchHttpTransport(hanging);
    expect((await thrown(() => transport.send(request({ timeoutMs: 20 })))).code).toBe(
      'TARGET_TIMEOUT',
    );

    const controller = new AbortController();
    const pending = thrown(() =>
      transport.send(request({ signal: controller.signal, timeoutMs: 5000 })),
    );
    controller.abort();
    expect((await pending).code).toBe('EXECUTION_CANCELLED');
  });

  it('maps network failures without echoing the URL or message', async () => {
    const failing = (() => {
      const error = new TypeError(
        'fetch failed: https://example.azure-api.net/orders/1?key=topsecret',
      );
      (error as { cause?: unknown }).cause = Object.assign(new Error('read ECONNRESET'), {
        code: 'ECONNRESET',
      });
      return Promise.reject(error);
    }) as unknown as typeof fetch;
    const error = await thrown(() => createFetchHttpTransport(failing).send(request()));
    expect(error.code).toBe('TARGET_SERVICE');
    expect(error.message).not.toContain('topsecret');
    expect(error.message).not.toContain('example.azure-api.net');
  });
});

describe('Azure SDK clients', () => {
  const KEY = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==';

  it('creates nothing and contacts nothing until a client is opened', () => {
    let credentialRequests = 0;
    createTargetClients({
      credentialFactory: () => {
        credentialRequests += 1;
        throw new Error('should not be called');
      },
    });
    expect(credentialRequests).toBe(0);
  });

  it('asks the credential factory once per process, and only for Entra targets', () => {
    let credentialRequests = 0;
    const clients = createTargetClients({
      credentialFactory: () => {
        credentialRequests += 1;
        return { getToken: () => Promise.resolve(null) };
      },
    });
    clients.openBlob({ accountUrl: 'https://example.blob.core.windows.net' });
    clients.openBlob({ accountUrl: 'https://example.blob.core.windows.net' });
    clients.openBlob({
      accountUrl: 'https://example.blob.core.windows.net',
      connectionString: `DefaultEndpointsProtocol=https;AccountName=example;AccountKey=${KEY};EndpointSuffix=core.windows.net`,
    });
    expect(credentialRequests).toBe(1);
  });

  it('does not put a malformed connection string into an error message', () => {
    const clients = createTargetClients();
    for (const open of [
      () =>
        clients.openBlob({
          accountUrl: 'https://example.blob.core.windows.net',
          connectionString: `AccountName=x;AccountKey=${KEY}`,
        }),
      () =>
        clients.openServiceBus({
          fullyQualifiedNamespace: 'example.servicebus.windows.net',
          connectionString: `SharedAccessKey=${KEY}`,
        }),
    ]) {
      try {
        open();
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(PlatformError);
        expect(
          JSON.stringify([(error as Error).message, (error as PlatformError).detail]),
        ).not.toContain(KEY);
      }
    }
  });
});
