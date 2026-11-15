import type { SecretReference } from './secrets.js';

export const ENVIRONMENT_CLASSIFICATIONS = ['LOCAL', 'TEST', 'STAGING', 'PRODUCTION'] as const;
export type EnvironmentClassification = (typeof ENVIRONMENT_CLASSIFICATIONS)[number];

export type HttpTarget = {
  kind: 'http';
  baseUrl: string;
  allowedPaths: string[];
  allowedMethods?: string[];
  /**
   * Phase 1 form: a bare name resolved by the `localPlainText` provider. Kept for compatibility;
   * prefer `authentication`. Never the secret itself.
   */
  secretRef?: string;
  /** Typed reference to the API key or token; never the secret itself. */
  authentication?: SecretReference;
  /** Send `x-correlation-id` and `x-test-platform-*` headers on requests; defaults to true. */
  correlationHeaders?: boolean;
};

export type AzureBlobTarget = {
  kind: 'azureBlob';
  accountUrl: string;
  allowedContainers: string[];
  /** Operations a Step may perform; when omitted, Phase 2 Steps allow `upload` and `download`. */
  allowedOperations?: AzureBlobOperation[];
  /** When set, blob names must start with one of these prefixes. */
  allowedBlobPrefixes?: string[];
  /** Typed reference to a connection string; when absent, Entra credentials are used. */
  credential?: SecretReference;
};

export const AZURE_BLOB_OPERATIONS = ['upload', 'download'] as const;
export type AzureBlobOperation = (typeof AZURE_BLOB_OPERATIONS)[number];

/**
 * `send` publishes a message. `inspect` lets the Service Bus Inspector *peek* at an entity
 * (non-destructive: nothing is received, completed or deleted). `inspect` is never implied.
 */
export const AZURE_SERVICE_BUS_OPERATIONS = ['send', 'inspect'] as const;
export type AzureServiceBusOperation = (typeof AZURE_SERVICE_BUS_OPERATIONS)[number];

export type AzureServiceBusTarget = {
  kind: 'azureServiceBus';
  /** Phase 1 name; `fullyQualifiedNamespace` is preferred. At least one of the two is required. */
  namespace?: string;
  fullyQualifiedNamespace?: string;
  allowedEntities: string[];
  allowedOperations?: AzureServiceBusOperation[];
  /** Typed reference to a connection string; when absent, Entra credentials are used. */
  credential?: SecretReference;
};

/**
 * `query` reads rows (SELECT). `insert`, `update` and `delete` change data and are never implied:
 * a target with no `allowedOperations` is read-only.
 */
export const SQL_SERVER_OPERATIONS = ['query', 'insert', 'update', 'delete'] as const;
export type SqlServerOperation = (typeof SQL_SERVER_OPERATIONS)[number];

export type SqlServerTarget = {
  kind: 'sqlServer';
  /** Host name of the SQL Server, optionally followed by `,port` (for example `db.example.com,1433`). */
  server: string;
  database: string;
  /** When set, a Step may only touch these schemas. */
  allowedSchemas?: string[];
  /** Operations a Step may perform; when omitted, only `query`. */
  allowedOperations?: SqlServerOperation[];
  /** Typed reference to a connection string; never the connection string itself. */
  credential?: SecretReference;
};

export type EnvironmentTarget =
  HttpTarget | AzureBlobTarget | AzureServiceBusTarget | SqlServerTarget;
export type TargetKind = EnvironmentTarget['kind'];

export type EnvironmentLimits = {
  maxStepTimeoutSeconds?: number;
  maxRetryAttempts?: number;
  maxPayloadCaptureBytes?: number;
  maxArtifactBytes?: number;
  maxSuiteSize?: number;
  /** Highest `maxConcurrency` a Suite Run may request in this Environment; defaults to 1. */
  maxSuiteConcurrency?: number;
};

export type EnvironmentConfig = {
  id: string;
  name: string;
  classification: EnvironmentClassification;
  limits?: EnvironmentLimits;
  /** Explicitly non-secret values exposed to the `environment` expression root. */
  values?: Record<string, string | number | boolean>;
  targets: Record<string, EnvironmentTarget>;
};

export type EnvironmentsFile = { environments: EnvironmentConfig[] };

/** Non-secret view of an Environment for browsers: target names and kinds only. */
export type EnvironmentSummary = {
  id: string;
  name: string;
  classification: EnvironmentClassification;
  targets: {
    name: string;
    kind: TargetKind;
    /** Service Bus targets only: what the inspector may watch (non-secret configuration). */
    serviceBus?: { entities: string[]; canInspect: boolean };
  }[];
  /**
   * Most Suite items the Environment lets a Suite Run execute at once (1 unless configured).
   * A non-secret policy value, so clients can bound the concurrency control.
   */
  suiteConcurrencyLimit: number;
};
