import type {
  ArtifactReference,
  ErrorInfo,
  JsonValue,
  Run,
  StepRun,
  TestNode,
} from '@test-platform/contracts';
import {
  PlatformError,
  TARGET_LIMITS,
  createTargetPolicy,
  createTargetResolver,
  type Clock,
  type Logger,
  type TargetClients,
  METRICS,
  noopMetrics,
  type MetricsSink,
} from '@test-platform/core';
import { newId, type LocalInfrastructure } from '@test-platform/infrastructure-local';
import { executeStep, type StepArtifactWriter, type StepDefinition } from '@test-platform/step-sdk';
import type { RunEmitter } from './emitter.js';
import { capJson, capLogs, isTruncatedPreview } from './payload.js';

export const OUTPUT_ARTIFACT_LABEL = 'step-output';

export type StepLimits = {
  /** Largest value persisted inline in a Step run row. */
  payloadBytes: number;
  /** Largest artifact a Step may write; the store's own cap still applies. */
  artifactBytes?: number;
};

export type AttemptInput = {
  run: Run;
  node: TestNode;
  definition: StepDefinition<unknown>;
  /** Resolved configuration; unmasked, held in memory only. */
  config: JsonValue;
  attempt: number;
  timeoutMs: number;
  signal: AbortSignal;
  limits: StepLimits;
  /** Decides, for a failed attempt, whether another attempt will follow. */
  willRetry: (error: ErrorInfo) => boolean;
};

export type AttemptOutcome =
  | { kind: 'succeeded'; stepRunId: string; output: JsonValue }
  | { kind: 'failed'; stepRunId: string; error: ErrorInfo; retrying: boolean }
  /** The signal fired; the row is left untouched so the caller can decide how to record it. */
  | { kind: 'aborted'; stepRunId: string };

type StepExecutorDeps = {
  infra: Pick<LocalInfrastructure, 'runs' | 'artifacts' | 'secrets' | 'redactor' | 'inspector'>;
  emitter: RunEmitter;
  clock: Clock;
  logger: Logger;
  /** Worker-side transports and Azure clients handed to target Steps. */
  clients: TargetClients;
  metrics?: MetricsSink;
};

/** Executes one attempt of one Step and persists every observable result immediately. */
export class StepExecutor {
  readonly #deps: StepExecutorDeps;

  constructor(deps: StepExecutorDeps) {
    this.#deps = deps;
  }

  #now(): string {
    return this.#deps.clock.now().toISOString();
  }

  async runAttempt(input: AttemptInput): Promise<AttemptOutcome> {
    const { infra, emitter, clock, logger } = this.#deps;
    const { run, node, definition, config, attempt, limits } = input;
    const stepRunId = newId();
    const correlation = { runId: run.id, stepRunId, nodeId: node.id, attempt };
    const log = logger.child(correlation);

    const row: StepRun = {
      id: stepRunId,
      runId: run.id,
      nodeId: node.id,
      attempt,
      status: 'Running',
      resolvedInput: capJson(
        infra.redactor.redact(config, definition.sensitivePaths ?? []) as JsonValue,
        limits.payloadBytes,
      ).value,
      logs: [],
      artifacts: [],
      startedAt: this.#now(),
    };
    await infra.runs.createStepRun(row);
    await emitter.stepStatus(row);
    log.info('Step attempt started', { type: node.type });

    const references: ArtifactReference[] = [];
    const artifacts: StepArtifactWriter = {
      write: async ({ content, contentType, label }) => {
        const size = typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength;
        if (limits.artifactBytes !== undefined && size > limits.artifactBytes) {
          throw new PlatformError(
            'EXECUTION_ARTIFACT',
            `The artifact exceeds the Environment limit of ${limits.artifactBytes} bytes.`,
          );
        }
        const stored = await infra.artifacts.write({
          runId: run.id,
          stepRunId,
          content: typeof content === 'string' ? infra.redactor.redactText(content) : content,
          contentType,
        });
        const reference: ArtifactReference = {
          id: stored.id,
          contentType: stored.contentType,
          sizeBytes: stored.sizeBytes,
          ...(label ? { label } : {}),
        };
        references.push(reference);
        await emitter.artifactCreated(run.id, stepRunId, reference);
        return reference;
      },
    };

    let outcome;
    try {
      outcome = await executeStep(
        definition,
        config,
        {
          signal: input.signal,
          artifacts,
          targets: createTargetResolver(run.snapshots.environment),
          policy: createTargetPolicy(run.snapshots.environment),
          clients: this.#deps.clients,
          limits: {
            payloadBytes: limits.payloadBytes,
            transferBytes: limits.artifactBytes ?? TARGET_LIMITS.blobBytes,
          },
          secrets: infra.secrets,
          secretReferences: infra.secrets,
          environmentId: run.snapshots.environment.id,
          inspector: infra.inspector,
          clock,
          correlation,
        },
        { timeoutMs: input.timeoutMs, redactor: infra.redactor },
      );
    } catch (error) {
      if (error instanceof PlatformError && error.code === 'EXECUTION_CANCELLED')
        return { kind: 'aborted', stepRunId };
      throw error;
    }

    const { result, maskedInput, durationMs } = outcome;
    const finishedAt = this.#now();
    const logs = capLogs(result.logs, limits.payloadBytes, () => this.#now());
    for (const reference of result.artifacts ?? []) {
      if (!references.some((existing) => existing.id === reference.id)) references.push(reference);
    }

    const failed = result.status === 'Failed';
    const error: ErrorInfo | undefined = failed
      ? (result.error ?? { code: 'SYSTEM_INTERNAL', message: 'The Step failed without an error.' })
      : undefined;
    const retrying = error !== undefined && input.willRetry(error);

    let outputPreview: JsonValue | undefined;
    if (result.output !== undefined) {
      const capped = capJson(result.output, limits.payloadBytes);
      outputPreview = capped.value;
      // The preview is lossy; keep the complete (already masked) output so a restarted worker
      // can still feed it to later Steps.
      if (capped.truncated && !failed) {
        try {
          await artifacts.write({
            content: JSON.stringify(result.output),
            contentType: 'application/json',
            label: OUTPUT_ARTIFACT_LABEL,
          });
        } catch (cause) {
          log.warn('The full Step output could not be stored as an artifact', {
            code: cause instanceof PlatformError ? cause.code : 'SYSTEM_INTERNAL',
          });
        }
      }
    }

    const patch = {
      status: failed
        ? retrying
          ? ('Retrying' as const)
          : ('Failed' as const)
        : ('Succeeded' as const),
      resolvedInput: capJson(maskedInput, limits.payloadBytes).value,
      ...(outputPreview !== undefined ? { outputPreview } : {}),
      ...(error ? { error } : {}),
      logs,
      artifacts: references,
      finishedAt,
      durationMs,
    };
    const saved = await infra.runs.updateStepRun(stepRunId, patch, 'Running');
    if (saved.outcome === 'rejected') {
      log.warn('Step run was no longer Running when its result arrived', {
        current: saved.current?.status,
      });
    }

    for (const entry of logs) await emitter.stepLog(run.id, stepRunId, entry);
    await emitter.stepStatus({ ...row, status: patch.status });

    const metrics = this.#deps.metrics ?? noopMetrics;
    const outcomeLabel = error ? (retrying ? 'retrying' : 'failed') : 'succeeded';
    metrics.increment(METRICS.stepAttempts, { type: node.type, outcome: outcomeLabel });
    metrics.observe(METRICS.stepDurationMs, durationMs, { type: node.type });
    if (error) metrics.increment(METRICS.stepFailures, { type: node.type, code: error.code });

    if (error) {
      log.info('Step attempt failed', { code: error.code, retrying, durationMs });
      return { kind: 'failed', stepRunId, error, retrying };
    }
    log.info('Step attempt succeeded', { durationMs });
    return { kind: 'succeeded', stepRunId, output: result.output ?? null };
  }

  /** Records a Step that could not start, for example because a parameter expression failed. */
  async recordFailure(run: Run, node: TestNode, attempt: number, error: ErrorInfo): Promise<void> {
    const now = this.#now();
    const row: StepRun = {
      id: newId(),
      runId: run.id,
      nodeId: node.id,
      attempt,
      status: 'Failed',
      error,
      logs: [],
      artifacts: [],
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
    };
    await this.#deps.infra.runs.createStepRun(row);
    await this.#deps.emitter.stepStatus(row);
  }

  async markCancelled(step: StepRun): Promise<void> {
    const saved = await this.#deps.infra.runs.updateStepRun(
      step.id,
      {
        status: 'Cancelled',
        error: { code: 'EXECUTION_CANCELLED', message: 'The Run was cancelled.' },
        finishedAt: this.#now(),
      },
      ['Running', 'Retrying', 'Paused'],
    );
    if (saved.outcome === 'applied') {
      await this.#deps.emitter.stepStatus({ ...step, status: 'Cancelled' });
    }
  }

  /** Masked, size-capped view of a resolved configuration, as persisted for inspection. */
  preview(
    config: JsonValue,
    sensitivePaths: readonly string[],
    payloadBytes: number,
  ): { value: JsonValue; truncated: boolean; masked: JsonValue } {
    const masked = this.#deps.infra.redactor.redact(config, sensitivePaths) as JsonValue;
    const capped = capJson(masked, payloadBytes);
    return { value: capped.value, truncated: capped.truncated, masked };
  }

  /** A disabled Breakpoint: recorded as Skipped with its reason, and never pauses the Run. */
  async recordSkipped(
    run: Run,
    node: TestNode,
    attempt: number,
    config: JsonValue,
    output: JsonValue,
    reason: string,
    limits: StepLimits,
  ): Promise<void> {
    const now = this.#now();
    const row: StepRun = {
      id: newId(),
      runId: run.id,
      nodeId: node.id,
      attempt,
      status: 'Skipped',
      resolvedInput: this.preview(config, [], limits.payloadBytes).value,
      outputPreview: output,
      logs: [{ timestamp: now, level: 'info', message: `Skipped: ${reason}.` }],
      artifacts: [],
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
    };
    await this.#deps.infra.runs.createStepRun(row);
    await this.#deps.emitter.stepStatus(row);
  }

  /** Opens the Running attempt of an enabled Breakpoint; the pause transaction moves it to Paused. */
  async beginBreakpoint(
    run: Run,
    node: TestNode,
    attempt: number,
    config: JsonValue,
    limits: StepLimits,
  ): Promise<StepRun> {
    const row: StepRun = {
      id: newId(),
      runId: run.id,
      nodeId: node.id,
      attempt,
      status: 'Running',
      resolvedInput: this.preview(config, [], limits.payloadBytes).value,
      logs: [],
      artifacts: [],
      startedAt: this.#now(),
    };
    await this.#deps.infra.runs.createStepRun(row);
    await this.#deps.emitter.stepStatus(row);
    return row;
  }

  /** A Running attempt that cannot continue (for example its successor input cannot be resolved). */
  async failOpen(step: StepRun, error: ErrorInfo): Promise<void> {
    const finishedAt = this.#now();
    const saved = await this.#deps.infra.runs.updateStepRun(
      step.id,
      { status: 'Failed', error, finishedAt },
      ['Running', 'Paused'],
    );
    if (saved.outcome === 'applied') {
      await this.#deps.emitter.stepStatus({ ...step, status: 'Failed' });
    }
  }

  /** On a valid continuation the paused Breakpoint attempt finishes as Succeeded. */
  async completeBreakpoint(step: StepRun, output: JsonValue): Promise<boolean> {
    const finishedAt = this.#now();
    const started = step.startedAt ? Date.parse(step.startedAt) : undefined;
    const saved = await this.#deps.infra.runs.updateStepRun(
      step.id,
      {
        status: 'Succeeded',
        outputPreview: output,
        finishedAt,
        ...(started !== undefined
          ? { durationMs: Math.max(Date.parse(finishedAt) - started, 0) }
          : {}),
      },
      'Paused',
    );
    if (saved.outcome === 'applied') {
      await this.#deps.emitter.stepStatus({ ...step, status: 'Succeeded' });
      return true;
    }
    return false;
  }

  /** Marks an attempt that was Running when its worker disappeared. */
  async markInterrupted(step: StepRun): Promise<void> {
    const saved = await this.#deps.infra.runs.updateStepRun(
      step.id,
      {
        status: 'Failed',
        error: {
          code: 'EXECUTION_LEASE',
          message: 'The attempt was interrupted by a worker restart or lease loss.',
        },
        finishedAt: this.#now(),
      },
      'Running',
    );
    if (saved.outcome === 'applied') {
      await this.#deps.emitter.stepStatus({ ...step, status: 'Failed' });
    }
  }

  /** Full output of a Step run that succeeded earlier, or undefined when it cannot be recovered. */
  async recoverOutput(step: StepRun): Promise<JsonValue | undefined> {
    if (step.outputPreview === undefined) return null;
    if (!isTruncatedPreview(step.outputPreview)) return step.outputPreview;
    const reference = step.artifacts.find((item) => item.label === OUTPUT_ARTIFACT_LABEL);
    if (!reference) return undefined;
    const stored = await this.#deps.infra.artifacts.read(reference.id);
    if (!stored) return undefined;
    try {
      return JSON.parse(Buffer.from(stored.content).toString('utf8')) as JsonValue;
    } catch {
      return undefined;
    }
  }
}
