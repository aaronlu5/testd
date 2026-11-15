import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import { ServiceBusClient, type ServiceBusReceivedMessage } from '@azure/service-bus';
import Long from 'long';
import { BlobServiceClient, type BlobGetPropertiesResponse } from '@azure/storage-blob';
import {
  PlatformError,
  mapTargetFailure,
  type BlobConnection,
  type BlobPort,
  type BlobProperties,
  type HttpTransport,
  type OutgoingMessage,
  type PeekedMessage,
  type ServiceBusConnection,
  type ServiceBusPort,
  type TargetClients,
} from '@test-platform/core';
import { createFetchHttpTransport } from './http-transport.js';
import { SdkSqlPort } from './sql-client.js';

export type TargetClientOptions = {
  /** Supplies Entra credentials when a target has no connection string. Defaults to `DefaultAzureCredential`. */
  credentialFactory?: () => TokenCredential;
  http?: HttpTransport;
};

const statusOf = (error: unknown): number | undefined => {
  const value = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof value === 'number' ? value : undefined;
};

const toProperties = (response: BlobGetPropertiesResponse): BlobProperties => ({
  ...(response.etag ? { etag: response.etag } : {}),
  ...(response.contentType ? { contentType: response.contentType } : {}),
  contentLength: response.contentLength ?? 0,
  ...(response.lastModified ? { lastModified: response.lastModified.toISOString() } : {}),
  ...(response.versionId ? { versionId: response.versionId } : {}),
  metadata: Object.fromEntries(
    Object.entries(response.metadata ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  ),
});

/**
 * The platform owns retries (they depend on the Step's idempotency), so the SDK clients are
 * configured not to retry on their own. Errors are translated by `mapTargetFailure`; SDK
 * messages, which can quote URLs and headers, are never propagated.
 */
const iso = (value: Date | undefined): string | undefined =>
  value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : undefined;

const toBytes = (body: unknown): Uint8Array => {
  if (body === undefined || body === null) return new Uint8Array(0);
  if (body instanceof Uint8Array) return new Uint8Array(body);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  // AMQP value / sequence bodies arrive already decoded; show them as JSON.
  return new TextEncoder().encode(JSON.stringify(body));
};

const toPeeked = (message: ServiceBusReceivedMessage): PeekedMessage => {
  const peeked: PeekedMessage = {
    body: toBytes(message.body),
    sequenceNumber: String(message.sequenceNumber ?? ''),
    applicationProperties: { ...(message.applicationProperties ?? {}) },
  };
  const strings: [keyof PeekedMessage, unknown][] = [
    ['contentType', message.contentType],
    ['messageId', message.messageId === undefined ? undefined : String(message.messageId)],
    [
      'correlationId',
      message.correlationId === undefined ? undefined : String(message.correlationId),
    ],
    ['sessionId', message.sessionId],
    ['partitionKey', message.partitionKey],
    ['subject', message.subject],
    ['to', message.to],
    ['replyTo', message.replyTo],
    ['deadLetterReason', message.deadLetterReason],
  ];
  for (const [key, value] of strings) {
    if (typeof value === 'string' && value !== '') (peeked as Record<string, unknown>)[key] = value;
  }
  const dates: [keyof PeekedMessage, Date | undefined][] = [
    ['enqueuedTime', message.enqueuedTimeUtc],
    ['scheduledEnqueueTime', message.scheduledEnqueueTimeUtc],
    ['expiresAt', message.expiresAtUtc],
    ['lockedUntil', message.lockedUntilUtc],
  ];
  for (const [key, value] of dates) {
    const formatted = iso(value);
    if (formatted) (peeked as Record<string, unknown>)[key] = formatted;
  }
  if (typeof message.timeToLive === 'number') peeked.timeToLiveMs = message.timeToLive;
  if (typeof message.deliveryCount === 'number') peeked.deliveryCount = message.deliveryCount;
  return peeked;
};

class SdkBlobPort implements BlobPort {
  readonly #service: BlobServiceClient;

  constructor(connection: BlobConnection, credentialFactory: () => TokenCredential) {
    const options = { retryOptions: { maxTries: 1 } };
    try {
      this.#service = connection.connectionString
        ? BlobServiceClient.fromConnectionString(connection.connectionString, options)
        : new BlobServiceClient(connection.accountUrl, credentialFactory(), options);
    } catch (error) {
      throw mapTargetFailure(error, 'Creating the blob client');
    }
  }

  async upload(input: Parameters<BlobPort['upload']>[0]): ReturnType<BlobPort['upload']> {
    const blob = this.#service
      .getContainerClient(input.container)
      .getBlockBlobClient(input.blobName);
    try {
      await blob.upload(Buffer.from(input.content), input.content.byteLength, {
        abortSignal: input.signal,
        blobHTTPHeaders: input.contentType ? { blobContentType: input.contentType } : {},
        metadata: input.metadata,
        ...(input.overwrite ? {} : { conditions: { ifNoneMatch: '*' } }),
      });
    } catch (error) {
      const status = statusOf(error);
      if (!input.overwrite && (status === 409 || status === 412)) return { created: false };
      throw mapTargetFailure(error, 'Blob upload');
    }
    const properties = await this.getProperties(input);
    if (!properties)
      throw new PlatformError('TARGET_SERVICE', 'The uploaded blob could not be read back.');
    return { created: true, properties };
  }

  async getProperties(input: {
    container: string;
    blobName: string;
    signal: AbortSignal;
  }): Promise<BlobProperties | undefined> {
    const blob = this.#service.getContainerClient(input.container).getBlobClient(input.blobName);
    try {
      return toProperties(await blob.getProperties({ abortSignal: input.signal }));
    } catch (error) {
      if (statusOf(error) === 404) return undefined;
      throw mapTargetFailure(error, 'Blob lookup');
    }
  }

  async download(input: Parameters<BlobPort['download']>[0]): ReturnType<BlobPort['download']> {
    const blob = this.#service.getContainerClient(input.container).getBlobClient(input.blobName);
    try {
      const properties = toProperties(await blob.getProperties({ abortSignal: input.signal }));
      if (properties.contentLength > input.maxBytes)
        throw new PlatformError(
          'TARGET_REQUEST',
          `The blob is ${properties.contentLength} bytes, above the limit of ${input.maxBytes} bytes.`,
        );
      const content = await blob.downloadToBuffer(0, properties.contentLength, {
        abortSignal: input.signal,
        ...(properties.etag ? { conditions: { ifMatch: properties.etag } } : {}),
      });
      return { content: new Uint8Array(content), properties };
    } catch (error) {
      throw mapTargetFailure(error, 'Blob download');
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class SdkServiceBusPort implements ServiceBusPort {
  readonly #client: ServiceBusClient;

  constructor(connection: ServiceBusConnection, credentialFactory: () => TokenCredential) {
    const options = { retryOptions: { maxRetries: 0 } };
    try {
      this.#client = connection.connectionString
        ? new ServiceBusClient(connection.connectionString, options)
        : new ServiceBusClient(connection.fullyQualifiedNamespace, credentialFactory(), options);
    } catch (error) {
      throw mapTargetFailure(error, 'Creating the Service Bus client');
    }
  }

  async send(input: {
    entity: string;
    message: OutgoingMessage;
    signal: AbortSignal;
  }): Promise<void> {
    const sender = this.#client.createSender(input.entity);
    try {
      const { message } = input;
      await sender.sendMessages(
        {
          body: Buffer.from(message.body),
          contentType: message.contentType,
          messageId: message.messageId,
          correlationId: message.correlationId,
          ...(message.subject ? { subject: message.subject } : {}),
          applicationProperties: message.applicationProperties,
        },
        { abortSignal: input.signal },
      );
    } catch (error) {
      throw mapTargetFailure(error, 'Service Bus send');
    } finally {
      await sender.close().catch(() => undefined);
    }
  }

  /** Peeks only: no lock is taken and nothing is completed, abandoned or deleted. */
  async peek(input: {
    entity: string;
    subscription?: string;
    fromSequenceNumber?: string;
    maxMessages: number;
    signal: AbortSignal;
  }): Promise<PeekedMessage[]> {
    const receiver = input.subscription
      ? this.#client.createReceiver(input.entity, input.subscription)
      : this.#client.createReceiver(input.entity);
    try {
      const messages = await receiver.peekMessages(input.maxMessages, {
        abortSignal: input.signal,
        ...(input.fromSequenceNumber
          ? { fromSequenceNumber: Long.fromString(input.fromSequenceNumber) }
          : {}),
      });
      return messages.map(toPeeked);
    } catch (error) {
      throw mapTargetFailure(error, 'Service Bus peek');
    } finally {
      await receiver.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    await this.#client.close().catch(() => undefined);
  }
}

/**
 * Real target clients. Nothing is created until a Step opens a client, secrets arrive only in
 * the `connectionString` argument, and every client is closed by the Step that opened it.
 */
export const createTargetClients = (options: TargetClientOptions = {}): TargetClients => {
  let credential: TokenCredential | undefined;
  // One credential per worker process lets DefaultAzureCredential cache its token.
  const credentialFactory = (): TokenCredential =>
    (credential ??= options.credentialFactory?.() ?? new DefaultAzureCredential());
  return {
    http: options.http ?? createFetchHttpTransport(),
    openBlob: (connection) => new SdkBlobPort(connection, credentialFactory),
    openServiceBus: (connection) => new SdkServiceBusPort(connection, credentialFactory),
    openSql: (connection) => new SdkSqlPort(connection),
  };
};
