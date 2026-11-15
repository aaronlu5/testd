/**
 * Optional Azure sandbox validation. NOT part of the normal test run.
 *
 * These tests contact real Azure resources and run only when TEST_PLATFORM_AZURE_SANDBOX=1.
 * Use dedicated non-production resources and the least-privileged identity that works. Never
 * run this against an Environment you would not mind receiving test traffic.
 * Setup and variables: ../Docs/Phase 2/azure-sandbox-validation.md
 *
 * Each section additionally needs its own variables and is skipped when they are absent.
 */
import { describe, expect, it } from 'vitest';
import { createTargetPolicy, type TargetClients } from '@test-platform/core';
import { createTargetClients } from '../src/index.js';

const enabled = process.env.TEST_PLATFORM_AZURE_SANDBOX === '1';
const variable = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
};

const blobAccountUrl = variable('TEST_PLATFORM_SANDBOX_BLOB_ACCOUNT_URL');
const blobContainer = variable('TEST_PLATFORM_SANDBOX_BLOB_CONTAINER');
const busNamespace = variable('TEST_PLATFORM_SANDBOX_SERVICEBUS_NAMESPACE');
const busEntity = variable('TEST_PLATFORM_SANDBOX_SERVICEBUS_QUEUE');
const busConnection = variable('TEST_PLATFORM_SANDBOX_SERVICEBUS_CONNECTION');
const httpBaseUrl = variable('TEST_PLATFORM_SANDBOX_HTTP_BASE_URL');
const httpPath = variable('TEST_PLATFORM_SANDBOX_HTTP_PATH');

const signal = () => new AbortController().signal;
const clients = (): TargetClients => createTargetClients();

describe.skipIf(!enabled)('Azure sandbox (explicit opt-in)', () => {
  describe.skipIf(!blobAccountUrl || !blobContainer)('Blob Storage', () => {
    it('uploads, reads back and downloads a uniquely named blob with Entra credentials', async () => {
      const policy = createTargetPolicy({
        id: 'sandbox',
        targets: {
          blob: {
            kind: 'azureBlob',
            accountUrl: blobAccountUrl as string,
            allowedContainers: [blobContainer as string],
            allowedBlobPrefixes: ['platform-sandbox/'],
          },
        },
      });
      const blobName = `platform-sandbox/${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
      policy.blob('blob', { operation: 'upload', container: blobContainer as string, blobName });

      const port = clients().openBlob({ accountUrl: blobAccountUrl as string });
      try {
        const content = new TextEncoder().encode(JSON.stringify({ sandbox: true }));
        const uploaded = await port.upload({
          container: blobContainer as string,
          blobName,
          content,
          contentType: 'application/json',
          overwrite: false,
          metadata: { platform_sandbox: 'true' },
          signal: signal(),
        });
        expect(uploaded.created).toBe(true);
        const again = await port.upload({
          container: blobContainer as string,
          blobName,
          content,
          overwrite: false,
          metadata: {},
          signal: signal(),
        });
        expect(again.created).toBe(false);
        const downloaded = await port.download({
          container: blobContainer as string,
          blobName,
          maxBytes: 1024,
          signal: signal(),
        });
        expect(new TextDecoder().decode(downloaded.content)).toBe('{"sandbox":true}');
        expect(downloaded.properties.etag).toBeTruthy();
      } finally {
        await port.close();
      }
    });
  });

  describe.skipIf(!busNamespace || !busEntity)('Service Bus', () => {
    it('sends one message to the sandbox queue (connection string if provided, else Entra)', async () => {
      const port = clients().openServiceBus({
        fullyQualifiedNamespace: busNamespace as string,
        ...(busConnection ? { connectionString: busConnection } : {}),
      });
      try {
        await port.send({
          entity: busEntity as string,
          message: {
            body: new TextEncoder().encode(JSON.stringify({ sandbox: true })),
            contentType: 'application/json',
            messageId: `platform-sandbox-${Date.now()}`,
            correlationId: 'platform-sandbox',
            applicationProperties: { platform_sandbox: true },
          },
          signal: signal(),
        });
      } finally {
        await port.close();
      }
    });
  });

  describe.skipIf(!httpBaseUrl || !httpPath)('HTTP / APIM', () => {
    it('performs a GET on the sandbox path', async () => {
      const url = new URL(httpPath as string, httpBaseUrl as string).toString();
      const response = await clients().http.send({
        method: 'GET',
        url,
        headers: { accept: 'application/json' },
        signal: signal(),
        timeoutMs: 15_000,
        maxResponseBytes: 64 * 1024,
      });
      expect(response.status).toBeLessThan(500);
    });
  });
});
