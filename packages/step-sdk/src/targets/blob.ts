import { createHash } from 'node:crypto';
import type { JsonObject, JsonValue } from '@test-platform/contracts';
import {
  PlatformError,
  TARGET_LIMITS,
  assertConnectionStringMatches,
  type BlobPlan,
  type BlobPort,
  type TargetPolicy,
} from '@test-platform/core';
import type { StepDefinition } from '../types.js';
import {
  asTargetError,
  describeCredential,
  resolveSecret,
  utf8,
  withClient,
  type Context,
} from './support.js';

export const BLOB_UPLOAD_STEP_TYPE = 'blob.upload';
export const BLOB_DOWNLOAD_STEP_TYPE = 'blob.download';

const METADATA_KEY = /^[a-z_][a-z0-9_]{0,63}$/;
const PRINTABLE_ASCII = /^[ -~]{0,256}$/;
const PLATFORM_METADATA_PREFIX = 'platform_';

const targetProperty = {
  type: 'string',
  minLength: 1,
  description: 'Logical Azure Blob target from the Environment.',
} as const;
const containerProperty = {
  type: 'string',
  minLength: 3,
  description: 'Container; must be allowed by the target.',
} as const;
const blobNameProperty = {
  type: 'string',
  minLength: 1,
  maxLength: 1024,
  description: 'Blob name; must be inside an allowed prefix when the target defines prefixes.',
} as const;

export type BlobUploadFile = { name: string; content: string; contentType?: string };

/** Either `blobName` with `content` (one blob) or `files` (one blob per file, named after it). */
export type BlobUploadConfig = {
  target: string;
  container: string;
  blobName?: string;
  content?: JsonValue;
  files?: BlobUploadFile[];
  /** `base64` decodes a string `content` to bytes; `utf8` (default) sends text or JSON. */
  contentEncoding?: 'utf8' | 'base64';
  contentType?: string;
  overwrite?: boolean;
  metadata?: Record<string, string>;
};

export type BlobDownloadConfig = {
  target: string;
  container: string;
  blobName: string;
  as?: 'text' | 'json' | 'base64';
  maxBytes?: number;
  expectedEtag?: string;
  storeArtifact?: boolean;
};

export const planBlobUpload = (
  config: Pick<BlobUploadConfig, 'target' | 'container'> & { blobName: string },
  policy: TargetPolicy,
): BlobPlan =>
  policy.blob(config.target, {
    operation: 'upload',
    container: config.container,
    blobName: config.blobName,
  });

/** Plans every blob a config would write: its files, or the single `blobName`. */
export const planBlobUploads = (config: BlobUploadConfig, policy: TargetPolicy): BlobPlan[] => {
  const names = config.files?.map((file) => file.name) ?? [config.blobName ?? ''];
  return names
    .filter((name, index) => name !== '' || index > 0 || config.files !== undefined)
    .map((blobName) => planBlobUpload({ ...config, blobName }, policy));
};

export const planBlobDownload = (config: BlobDownloadConfig, policy: TargetPolicy): BlobPlan =>
  policy.blob(config.target, {
    operation: 'download',
    container: config.container,
    blobName: config.blobName,
  });

const checkTargetExists = (
  context: { targets?: { resolve: (name: string, kind: 'azureBlob') => unknown } },
  target: string,
) => {
  if (!context.targets) return [];
  try {
    context.targets.resolve(target, 'azureBlob');
    return [];
  } catch (error) {
    return [
      {
        path: '/target',
        message: error instanceof PlatformError ? error.message : 'Unknown target.',
        keyword: 'target-policy',
      },
    ];
  }
};

/** Opens a client for the target: a referenced connection string, or Entra when none is set. */
const openBlob = async (context: Context, plan: BlobPlan): Promise<BlobPort> => {
  const credential = plan.target.credential;
  context.logger.info(`Authenticating to blob target with ${describeCredential(credential)}`);
  if (!credential) return context.clients.openBlob({ accountUrl: plan.target.accountUrl });
  const connectionString = await resolveSecret(context, credential);
  assertConnectionStringMatches('azureBlob', connectionString, plan.accountHost);
  return context.clients.openBlob({ accountUrl: plan.target.accountUrl, connectionString });
};

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const checkMetadata = (metadata: Record<string, string> | undefined): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    const lower = key.toLowerCase();
    if (!METADATA_KEY.test(lower) || lower.startsWith(PLATFORM_METADATA_PREFIX))
      throw new PlatformError(
        'VALIDATION_SCHEMA',
        `Metadata key "${key}" is not valid (letters, digits and "_"; "${PLATFORM_METADATA_PREFIX}" is reserved).`,
      );
    if (!PRINTABLE_ASCII.test(value))
      throw new PlatformError(
        'VALIDATION_SCHEMA',
        `Metadata value for "${key}" must be printable ASCII of at most 256 characters.`,
      );
    result[lower] = value;
  }
  return result;
};

const encodeContent = (
  config: BlobUploadConfig,
  content: JsonValue,
): { bytes: Uint8Array; contentType: string } => {
  if (config.contentEncoding === 'base64') {
    if (
      typeof content !== 'string' ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(content) ||
      content.length % 4 !== 0
    )
      throw new PlatformError('VALIDATION_SCHEMA', 'Content must be a base64 string.');
    return {
      bytes: new Uint8Array(Buffer.from(content, 'base64')),
      contentType: config.contentType ?? 'application/octet-stream',
    };
  }
  if (typeof content === 'string')
    return { bytes: utf8(content), contentType: config.contentType ?? 'text/plain; charset=utf-8' };
  return {
    bytes: utf8(JSON.stringify(content)),
    contentType: config.contentType ?? 'application/json',
  };
};

const safeEtag = (value: string | undefined): string | null => value ?? null;

type Upload = { blobName: string; bytes: Uint8Array; contentType: string };

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_UPLOAD_FILES = 20;

const contentSourceIssues = (config: BlobUploadConfig) => {
  const single = config.blobName !== undefined || config.content !== undefined;
  const issue = (path: string, message: string) => ({ path, message, keyword: 'content-source' });
  if (config.files !== undefined) {
    if (single)
      return [issue('/files', 'Use either "files" or "blobName" with "content", not both.')];
    const seen = new Set<string>();
    return config.files.flatMap((file, index) => {
      if (!seen.has(file.name)) {
        seen.add(file.name);
        return [];
      }
      return [issue(`/files/${index}/name`, `Two files are both named "${file.name}".`)];
    });
  }
  if (config.blobName === undefined || config.content === undefined)
    return [issue('/blobName', 'Give "blobName" and "content", or upload "files".')];
  return [];
};

const collectUploads = (config: BlobUploadConfig): Upload[] => {
  const problem = contentSourceIssues(config)[0];
  if (problem) throw new PlatformError('VALIDATION_SCHEMA', problem.message);
  if (config.files !== undefined)
    return config.files.map((file) => {
      if (!BASE64.test(file.content) || file.content.length % 4 !== 0)
        throw new PlatformError('VALIDATION_SCHEMA', `File "${file.name}" is not valid base64.`);
      return {
        blobName: file.name,
        bytes: new Uint8Array(Buffer.from(file.content, 'base64')),
        contentType: file.contentType ?? config.contentType ?? 'application/octet-stream',
      };
    });
  return [
    { blobName: config.blobName as string, ...encodeContent(config, config.content as JsonValue) },
  ];
};

export const blobUploadStep: StepDefinition<BlobUploadConfig> = {
  type: BLOB_UPLOAD_STEP_TYPE,
  displayName: 'Blob upload',
  description:
    'Uploads JSON, text or binary content, or one or more files, to an allowlisted container of an Azure Blob target and records the ETags. Files become blobs named after them. By default an existing blob is never replaced; retries of the same Step are safe.',
  configSchema: {
    type: 'object',
    required: ['target', 'container'],
    additionalProperties: false,
    properties: {
      target: targetProperty,
      container: containerProperty,
      blobName: blobNameProperty,
      content: { description: 'String or JSON value to upload.' },
      files: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_UPLOAD_FILES,
        description: 'Files to upload instead of "content"; each blob is named after its file.',
        items: {
          type: 'object',
          required: ['name', 'content'],
          additionalProperties: false,
          properties: {
            name: blobNameProperty,
            content: { type: 'string', description: 'The file bytes, base64 encoded.' },
            contentType: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
      },
      contentEncoding: { enum: ['utf8', 'base64'] },
      contentType: { type: 'string', minLength: 1, maxLength: 256 },
      overwrite: {
        type: 'boolean',
        description:
          'Replace an existing blob. When false (default) an existing blob fails the Step.',
      },
      metadata: { type: 'object', additionalProperties: { type: 'string' } },
    },
  },
  sensitivePaths: ['content', 'files.*.content'],
  defaults: { contentEncoding: 'utf8', overwrite: false },
  capabilities: { external: true, supportsRetry: true, supportsArtifacts: false },
  validate: (config, context) => [
    ...checkTargetExists(context, config.target),
    ...contentSourceIssues(config),
  ],
  async execute(context, config) {
    const uploads = collectUploads(config);
    // Check every blob against the policy and the size cap before anything is written.
    const plans = planBlobUploads(config, context.policy);
    const ceiling = Math.min(TARGET_LIMITS.blobBytes, context.limits.transferBytes);
    for (const upload of uploads)
      if (upload.bytes.byteLength > ceiling)
        throw new PlatformError(
          'VALIDATION_TARGET_POLICY',
          `The content of "${upload.blobName}" (${upload.bytes.byteLength} bytes) exceeds the upload limit of ${ceiling} bytes.`,
        );
    const { runId, stepRunId, nodeId, attempt } = context.correlation;
    const baseMetadata = checkMetadata(config.metadata);
    const overwrite = config.overwrite === true;

    const first = plans[0] as BlobPlan;
    const client = await openBlob(context, first);
    const results = await withClient(client, async (blob) => {
      const done: { upload: Upload; plan: BlobPlan; digest: string; result: UploadResult }[] = [];
      for (const [index, upload] of uploads.entries()) {
        const plan = plans[index] as BlobPlan;
        const digest = sha256(upload.bytes);
        const metadata = {
          ...baseMetadata,
          platform_run_id: runId,
          platform_step_run_id: stepRunId,
          platform_node_id: nodeId,
          platform_attempt: String(attempt),
          platform_sha256: digest,
        };
        const action = `Blob upload to ${plan.container}/${plan.blobName}`;
        try {
          const uploaded = await blob.upload({
            container: plan.container,
            blobName: plan.blobName,
            content: upload.bytes,
            contentType: upload.contentType,
            overwrite,
            metadata,
            signal: context.signal,
          });
          if (uploaded.created) {
            done.push({
              upload,
              plan,
              digest,
              result: { properties: uploaded.properties, reused: false },
            });
            continue;
          }

          // The blob exists. It is ours if an earlier attempt of this very Step wrote it.
          const existing = await blob.getProperties({
            container: plan.container,
            blobName: plan.blobName,
            signal: context.signal,
          });
          if (
            existing &&
            existing.metadata.platform_run_id === runId &&
            existing.metadata.platform_node_id === nodeId &&
            existing.metadata.platform_sha256 === digest
          ) {
            done.push({ upload, plan, digest, result: { properties: existing, reused: true } });
            continue;
          }
          throw new PlatformError(
            'TARGET_REQUEST',
            `Blob "${plan.blobName}" already exists in container "${plan.container}". Use a unique blob name or set overwrite to true.`,
          );
        } catch (error) {
          throw asTargetError(error, action);
        }
      }
      return done;
    });

    for (const { upload, plan, result } of results)
      context.logger.info(
        result.reused ? 'Blob already uploaded by an earlier attempt' : 'Blob uploaded',
        {
          container: plan.container,
          blobName: plan.blobName,
          sizeBytes: upload.bytes.byteLength,
        },
      );

    const describe = ({ upload, plan, digest, result }: (typeof results)[number]): JsonObject => ({
      blobName: plan.blobName,
      etag: safeEtag(result.properties.etag),
      lastModified: result.properties.lastModified ?? null,
      versionId: result.properties.versionId ?? null,
      sizeBytes: upload.bytes.byteLength,
      contentType: upload.contentType,
      sha256: digest,
      reusedFromEarlierAttempt: result.reused,
    });
    const output: JsonObject =
      config.files === undefined
        ? {
            target: config.target,
            container: first.container,
            ...describe(results[0] as (typeof results)[number]),
            overwrite,
          }
        : {
            target: config.target,
            container: first.container,
            count: results.length,
            totalBytes: results.reduce((sum, item) => sum + item.upload.bytes.byteLength, 0),
            uploads: results.map(describe),
            overwrite,
          };
    return { status: 'Succeeded', output, logs: context.logger.entries() };
  },
};

type UploadResult = {
  properties: { etag?: string; lastModified?: string; versionId?: string };
  reused: boolean;
};

export const blobDownloadStep: StepDefinition<BlobDownloadConfig> = {
  type: BLOB_DOWNLOAD_STEP_TYPE,
  displayName: 'Blob download',
  description:
    'Reads a blob from an allowlisted container for verification. The content is size-limited, shown inline when small, and stored as an artifact.',
  configSchema: {
    type: 'object',
    required: ['target', 'container', 'blobName'],
    additionalProperties: false,
    properties: {
      target: targetProperty,
      container: containerProperty,
      blobName: blobNameProperty,
      as: { enum: ['text', 'json', 'base64'] },
      maxBytes: { type: 'integer', minimum: 1 },
      expectedEtag: { type: 'string', minLength: 1 },
      storeArtifact: { type: 'boolean' },
    },
  },
  sensitivePaths: [],
  defaults: { as: 'text', storeArtifact: true },
  capabilities: { external: true, supportsRetry: true, supportsArtifacts: true },
  validate: (config, context) => checkTargetExists(context, config.target),
  async execute(context, config) {
    const plan = planBlobDownload(config, context.policy);
    const ceiling = Math.min(TARGET_LIMITS.blobBytes, context.limits.transferBytes);
    const maxBytes = Math.min(config.maxBytes ?? ceiling, ceiling);
    const action = `Blob download of ${plan.container}/${plan.blobName}`;

    const client = await openBlob(context, plan);
    const { content, properties } = await withClient(client, async (blob) => {
      try {
        return await blob.download({
          container: plan.container,
          blobName: plan.blobName,
          maxBytes,
          signal: context.signal,
        });
      } catch (error) {
        throw asTargetError(error, action);
      }
    });

    if (config.expectedEtag !== undefined && properties.etag !== config.expectedEtag)
      throw new PlatformError(
        'TARGET_REQUEST',
        `${action} returned a different ETag than expected.`,
      );
    if (content.byteLength > maxBytes)
      throw new PlatformError(
        'TARGET_REQUEST',
        `${action} exceeded the size limit of ${maxBytes} bytes.`,
      );

    const mode = config.as ?? 'text';
    const inlineBytes = Math.max(Math.floor(context.limits.payloadBytes / 2), 256);
    const clipped = content.byteLength > inlineBytes;
    const slice = clipped ? content.subarray(0, inlineBytes) : content;
    let inline: JsonValue;
    let encoding: 'text' | 'json' | 'base64' = mode;
    if (mode === 'base64') inline = Buffer.from(slice).toString('base64');
    else {
      const text = new TextDecoder().decode(slice);
      if (mode === 'json' && !clipped) {
        try {
          inline = JSON.parse(text) as JsonValue;
        } catch {
          throw new PlatformError('TARGET_REQUEST', `${action} did not return valid JSON.`);
        }
      } else {
        inline = text;
        encoding = 'text';
      }
    }

    const artifacts = [];
    let artifactId: string | null = null;
    if (config.storeArtifact !== false) {
      try {
        const isText = mode !== 'base64';
        const reference = await context.artifacts.write({
          content: isText ? new TextDecoder().decode(content) : content,
          contentType:
            properties.contentType ?? (isText ? 'text/plain' : 'application/octet-stream'),
          label: 'blob-content',
        });
        artifacts.push(reference);
        artifactId = reference.id;
      } catch {
        context.logger.warn('The blob content could not be stored as an artifact.');
      }
    }

    context.logger.info('Blob downloaded', {
      container: plan.container,
      blobName: plan.blobName,
      sizeBytes: content.byteLength,
    });
    const output: JsonObject = {
      target: config.target,
      container: plan.container,
      blobName: plan.blobName,
      etag: safeEtag(properties.etag),
      lastModified: properties.lastModified ?? null,
      contentType: properties.contentType ?? null,
      sizeBytes: content.byteLength,
      sha256: sha256(content),
      content: inline,
      contentEncoding: encoding,
      contentTruncated: clipped,
      artifactId,
    };
    return { status: 'Succeeded', output, logs: context.logger.entries(), artifacts };
  },
};
