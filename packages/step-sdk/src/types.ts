import type {
  ArtifactReference,
  ErrorInfo,
  JsonObject,
  JsonPath,
  JsonSchema,
  JsonValue,
  LogLevel,
  StepCapabilities,
  StepLogEntry,
  ValidationIssue,
} from '@test-platform/contracts';
import type {
  Clock,
  InspectorSink,
  SecretReferenceResolver,
  TargetClients,
  TargetPolicy,
  TargetResolver,
} from '@test-platform/core';

export type ValidationContext = {
  /** Present when validating against an Environment; Steps must not bypass it. */
  targets?: TargetResolver;
};

export interface StepLogger {
  debug(message: string, data?: JsonValue): void;
  info(message: string, data?: JsonValue): void;
  warn(message: string, data?: JsonValue): void;
  error(message: string, data?: JsonValue): void;
  /** Entries recorded so far; return them as `StepResult.logs`. */
  entries(): readonly StepLogEntry[];
}

export interface StepArtifactWriter {
  write(input: {
    content: Uint8Array | string;
    contentType: string;
    label?: string;
  }): Promise<ArtifactReference>;
}

export interface SecretResolver {
  getSecret(name: string): Promise<string | undefined>;
}

/** Size ceilings for the current Run, derived from the Environment. */
export type StepRuntimeLimits = {
  /** Largest value kept inline in a Step's output. */
  payloadBytes: number;
  /** Largest artifact or transfer (upload, download, response body) the Step may handle. */
  transferBytes: number;
};

export type StepCorrelation = { runId: string; stepRunId: string; nodeId: string; attempt: number };

/** Everything a Step may touch; Steps must not create their own unrestricted clients. */
export type StepExecutionContext = {
  signal: AbortSignal;
  logger: StepLogger;
  artifacts: StepArtifactWriter;
  targets: TargetResolver;
  secrets: SecretResolver;
  /** Typed resolver for target credentials; call it immediately before use and never log the value. */
  secretReferences: SecretReferenceResolver;
  /** Allowlist decisions for target Steps; derived from the Run's Environment snapshot. */
  policy: TargetPolicy;
  /** Worker-side transports and Azure clients; Steps never build their own. */
  clients: TargetClients;
  limits: StepRuntimeLimits;
  /** Id of the Environment the Run executes in (from its snapshot). */
  environmentId: string;
  /** The Service Bus Inspector; calls are best-effort and never fail a Step. */
  inspector: InspectorSink;
  clock: Clock;
  correlation: StepCorrelation;
  /** Test seam: replaces the cancellable sleep used while polling. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

export type StepResultStatus = 'Succeeded' | 'Failed' | 'Skipped';

export type StepResult = {
  status: StepResultStatus;
  output?: JsonValue;
  logs: readonly StepLogEntry[];
  artifacts?: ArtifactReference[];
  /** Required when `status` is `Failed`. */
  error?: ErrorInfo;
};

export interface StepDefinition<TConfig = unknown> {
  type: string;
  displayName: string;
  description?: string;
  /** Standalone JSON Schema (no `$id`) for the resolved configuration. */
  configSchema: JsonSchema;
  /** Paths masked in persisted input, output, and logs. */
  sensitivePaths?: JsonPath[];
  defaults?: JsonObject;
  capabilities?: Partial<StepCapabilities>;
  /** Semantic checks beyond the schema. */
  validate(config: TConfig, context: ValidationContext): ValidationIssue[];
  execute(context: StepExecutionContext, config: TConfig): Promise<StepResult>;
}

export type { LogLevel };
