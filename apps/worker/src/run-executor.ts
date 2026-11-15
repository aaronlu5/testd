import {
  BREAKPOINT_MESSAGE_MAX_LENGTH,
  BREAKPOINT_STEP_TYPE,
  type ErrorInfo,
  type JsonValue,
  type Run,
  type RunPause,
  type StepRun,
  type TestNode,
} from '@test-platform/contracts';
import {
  type MockApiRegistry,
  PlatformError,
  cancellableSleep,
  computeBackoffMs,
  effectiveRetryPolicy,
  isCancellationRequested,
  isRetryableCode,
  isTerminalRunStatus,
  resolveValue,
  globalsOfRun,
  resolveTestData,
  resolveVariables,
  shouldRetry,
  toErrorInfo,
  validateFlow,
  type Clock,
  type EffectiveRetryPolicy,
  type Job,
  type ExpressionContext,
  type Logger,
  type TargetClients,
  METRICS,
  noopMetrics,
  type MetricsSink,
} from '@test-platform/core';
import type { LocalInfrastructure } from '@test-platform/infrastructure-local';
import { breakpointOutput, type StepRegistry } from '@test-platform/step-sdk';
import type { WorkerConfig } from './config.js';
import { RunEmitter } from './emitter.js';
import { StepExecutor, type StepLimits } from './step-executor.js';

/** What the job loop must do with the job once the executor returns. */
export type JobDisposition =
  /** The Run reached a final state (or needed no work): mark the job completed. */
  | { kind: 'complete' }
  /** The job cannot be processed at all: mark it failed. */
  | { kind: 'fail'; error: string }
  /** The worker is shutting down: hand the job back so another claim resumes the Run. */
  | { kind: 'release' }
  /** The lease belongs to someone else now: touch nothing. */
  | { kind: 'abandon' };

export type InterruptReason = 'shutdown' | 'lease-lost';

type Deps = {
  config: WorkerConfig;
  infra: LocalInfrastructure;
  registry: StepRegistry;
  clock: Clock;
  logger: Logger;
  clients: TargetClients;
  metrics?: MetricsSink;
  /** Setups served by the Mock API server while a Run executes. */
  mocks?: MockApiRegistry;
};

type FlowResult =
  | { kind: 'succeeded' }
  /** The Run paused at a Breakpoint; the pause transaction already released the job. */
  | { kind: 'paused' }
  /** The lease belongs to someone else; touch nothing. */
  | { kind: 'abandoned' }
  | { kind: 'failed'; error: ErrorInfo }
  | { kind: 'cancelled' }
  | { kind: 'interrupted' };

type NodeResult =
  | { kind: 'succeeded'; output: JsonValue }
  | { kind: 'failed'; error: ErrorInfo }
  | { kind: 'aborted' };

/**
 * Executes one Run, sequentially, from its embedded snapshots.
 *
 * Run: Queued -> Running -> Succeeded | Failed, or Running -> Cancelling -> Cancelled when a
 * cancellation is requested. Delivery is at-least-once: re-entering a Run that is already
 * Running resumes it from the persisted Step runs, so every write here is safe to repeat.
 * Events are published before the terminal transition because the SSE stream ends when the Run
 * is terminal and no further events exist.
 */
export class RunExecutor {
  readonly #deps: Deps;
  readonly #emitter: RunEmitter;
  readonly #steps: StepExecutor;

  constructor(deps: Deps) {
    this.#deps = deps;
    this.#emitter = new RunEmitter(deps.infra.events, deps.clock);
    this.#steps = new StepExecutor({
      infra: deps.infra,
      emitter: this.#emitter,
      clock: deps.clock,
      logger: deps.logger,
      clients: deps.clients,
      ...(deps.metrics ? { metrics: deps.metrics } : {}),
    });
  }

  get #metrics(): MetricsSink {
    return this.#deps.metrics ?? noopMetrics;
  }

  #now(): string {
    return this.#deps.clock.now().toISOString();
  }

  /** `interrupt` aborts with an {@link InterruptReason} when the worker stops or loses the lease. */
  async execute(job: Job, interrupt: AbortSignal): Promise<JobDisposition> {
    const { infra } = this.#deps;
    const logger = this.#deps.logger.child({ jobId: job.id, runId: job.runId });

    let run = await infra.runs.getRun(job.runId);
    if (!run) {
      logger.error('Job refers to a Run that does not exist');
      return { kind: 'fail', error: 'The Run does not exist.' };
    }
    if (isTerminalRunStatus(run.status)) {
      logger.info('Run is already final; nothing to do', { status: run.status });
      return { kind: 'complete' };
    }
    if (run.status === 'Paused') {
      // A paused Run holds no job; a stray one must not execute anything while waiting.
      logger.warn('Job refers to a Run that is paused; nothing to do');
      return { kind: 'complete' };
    }
    if (run.status === 'Cancelling') {
      await this.#finalize(run, 'Cancelled');
      return { kind: 'complete' };
    }
    if (run.status === 'Queued') {
      const started = await infra.runs.transitionRun(run.id, {
        from: 'Queued',
        to: 'Running',
        at: this.#now(),
      });
      if (started.outcome === 'rejected') {
        // Cancelled (or otherwise moved) between the read and the transition: look again.
        return this.execute(job, interrupt);
      }
      run = started.current ?? run;
      await this.#emitter.runStatus(run.id, 'Running');
      logger.info('Run started');
      this.#metrics.increment(METRICS.runsStarted, {
        continuation: (run.continuationGeneration ?? 0) > 0 ? 'true' : 'false',
      });
    } else {
      logger.info('Resuming a Run that was already Running', { jobAttempt: job.attempts });
    }

    const cancel = new AbortController();
    const watcher = setInterval(() => {
      void infra.runs
        .getRun(run.id)
        .then((current) => {
          if (current && isCancellationRequested(current)) cancel.abort();
        })
        .catch((error: unknown) => {
          logger.warn('Cancellation check failed', {
            error: error instanceof Error ? error.message : 'unknown',
          });
        });
    }, this.#deps.config.cancelPollMs);
    watcher.unref();

    const signal = AbortSignal.any([interrupt, cancel.signal]);
    // The Run's Mock API setups are live from here until it ends. A Run paused at a Breakpoint
    // keeps them so the SUT can still be exercised; the server drops them once the Run is final.
    let keepMocks = false;
    this.#deps.mocks?.register(run.id, run.snapshots.mockSetups ?? []);
    try {
      const outcome = await this.#runFlow(run, job, signal, logger);
      switch (outcome.kind) {
        case 'succeeded':
          await this.#finalize(run, 'Succeeded');
          break;
        case 'failed':
          await this.#finalize(run, 'Failed', outcome.error);
          break;
        case 'cancelled':
          await this.#finalize(run, 'Cancelled');
          break;
        case 'paused':
          logger.info('Run paused at a Breakpoint');
          keepMocks = true;
          this.#metrics.increment(METRICS.runsPaused);
          break;
        case 'abandoned':
          return { kind: 'abandon' };
        case 'interrupted':
          return interrupt.reason === 'lease-lost' ? { kind: 'abandon' } : { kind: 'release' };
      }
      return { kind: 'complete' };
    } catch (error) {
      if (interrupt.aborted) {
        return interrupt.reason === 'lease-lost' ? { kind: 'abandon' } : { kind: 'release' };
      }
      logger.error('Unexpected error while executing the Run', {
        error: error instanceof Error ? error.message : 'unknown',
      });
      await this.#finalize(run, 'Failed', toErrorInfo(error));
      return { kind: 'complete' };
    } finally {
      clearInterval(watcher);
      if (!keepMocks) this.#deps.mocks?.unregister(run.id);
    }
  }

  async #runFlow(run: Run, job: Job, signal: AbortSignal, logger: Logger): Promise<FlowResult> {
    const { infra, registry } = this.#deps;
    const test = run.snapshots.test;
    if (run.kind !== 'test' || !test) {
      return {
        kind: 'failed',
        error: {
          code: 'VALIDATION_REFERENCE',
          message: 'Only Test Runs with a Test snapshot can be executed by this worker.',
        },
      };
    }

    const flow = validateFlow(test, { isKnownStepType: (type) => registry.has(type) });
    if (!flow.valid) {
      return {
        kind: 'failed',
        error: {
          code: 'VALIDATION_FLOW',
          message: 'The Test flow is not executable.',
          detail: flow.issues.map((issue) => issue.message).join('; '),
        },
      };
    }

    const environment = run.snapshots.environment;
    const globals = globalsOfRun(run);
    let base: Pick<ExpressionContext, 'testData' | 'environment' | 'global'>;
    let variables: Record<string, JsonValue>;
    try {
      // Test Data may use {{ global.* }}; it is resolved once, so the whole Run sees one value.
      base = {
        testData: resolveTestData((run.snapshots.testData?.data ?? {}) as JsonValue, globals),
        environment: environment.values ?? {},
        global: globals,
      };
      variables = resolveVariables(test.variables, base, run.variableOverrides);
    } catch (error) {
      return { kind: 'failed', error: this.#safeError(error, 'Variables could not be resolved.') };
    }

    const priorByNode = new Map<string, StepRun>();
    for (const step of await infra.runs.listStepRuns(run.id)) {
      const known = priorByNode.get(step.nodeId);
      if (!known || known.attempt < step.attempt) priorByNode.set(step.nodeId, step);
    }

    const nodes = new Map(test.nodes.map((node) => [node.id, node]));
    const steps: ExpressionContext['steps'] = {};

    // Pauses already resumed, keyed by the successor they promised to run. The successor must
    // still resolve to the input that was inspected before it executes for the first time.
    const resumedInto = new Map<string, RunPause>();
    for (const pause of await infra.pauses.listPauses(run.id)) {
      if (pause.resumedAt && !pause.cancelledAt && pause.nextNodeId)
        resumedInto.set(pause.nextNodeId, pause);
    }

    for (const [index, nodeId] of flow.order.entries()) {
      if (signal.aborted) return this.#abortedResult(signal);
      const node = nodes.get(nodeId) as TestNode;
      const definition = registry.require(node.type);
      const prior = priorByNode.get(nodeId);
      const current = await infra.runs.getRun(run.id);
      if (current && isCancellationRequested(current)) {
        if (prior) await this.#steps.markCancelled(prior);
        return { kind: 'cancelled' };
      }
      const policy = this.#policy(node, definition.capabilities?.supportsRetry, run);
      let attempt = 1;

      if (prior) {
        if (prior.status === 'Paused') {
          const continued = await this.#continueBreakpoint(run, node, prior, logger);
          if (continued.kind === 'failed') return { kind: 'failed', error: continued.error };
          steps[nodeId] = { output: continued.output };
          continue;
        }
        if (prior.status === 'Succeeded' || prior.status === 'Skipped') {
          const output = await this.#steps.recoverOutput(prior);
          if (output === undefined) {
            return {
              kind: 'failed',
              error: {
                code: 'EXECUTION_LEASE',
                message: `Step "${node.name}" finished before the worker restarted, but its output could not be recovered.`,
              },
            };
          }
          steps[nodeId] = { output };
          logger.info('Reusing the result of a completed Step after a restart', { nodeId });
          continue;
        }
        if (prior.status === 'Cancelled') return { kind: 'cancelled' };
        if (prior.status === 'Failed' && prior.error?.code !== 'EXECUTION_LEASE') {
          return { kind: 'failed', error: this.#stepFailure(node, prior.error) };
        }
        if (prior.status === 'Running') await this.#steps.markInterrupted(prior);
        attempt = prior.attempt + 1;
        const external = definition.capabilities?.external ?? false;
        // Target operations are not assumed idempotent: replay an interrupted external Step only
        // when its retry policy grants another attempt.
        if (prior.status !== 'Retrying' && external && attempt > policy.maxAttempts) {
          return {
            kind: 'failed',
            error: {
              code: 'EXECUTION_LEASE',
              message: `Step "${node.name}" was interrupted and is not safe to replay.`,
              detail:
                'The Step calls an external target and its retry policy allows no further attempt.',
            },
          };
        }
        logger.info('Resuming a Step after a restart', { nodeId, attempt });
      }

      let config: JsonValue;
      try {
        config = resolveValue(node.parameters, { ...base, variables, steps });
      } catch (error) {
        const info = this.#safeError(error, 'Step parameters could not be resolved.');
        await this.#steps.recordFailure(run, node, attempt, info);
        return { kind: 'failed', error: this.#stepFailure(node, info) };
      }

      const promised = prior ? undefined : resumedInto.get(nodeId);
      if (promised) {
        const now = this.#steps.preview(
          config,
          definition.sensitivePaths ?? [],
          this.#limits(run).payloadBytes,
        ).value;
        if (stableJson(now) !== stableJson(promised.nextResolvedInputPreview ?? null)) {
          const info: ErrorInfo = {
            code: 'EXECUTION_BREAKPOINT_CONTEXT_CHANGED',
            message:
              'The input of this Step no longer matches what was inspected at the Breakpoint, so the Run cannot continue.',
            detail: `Breakpoint "${promised.breakpointNodeId}" paused the Run before Step "${node.id}".`,
          };
          await this.#steps.recordFailure(run, node, attempt, info);
          return { kind: 'failed', error: this.#stepFailure(node, info) };
        }
      }

      if (node.type === BREAKPOINT_STEP_TYPE) {
        const handled = await this.#breakpoint({
          run,
          job,
          node,
          attempt,
          config,
          order: flow.order,
          index,
          nodes,
          base,
          variables,
          steps,
          logger,
        });
        if (handled.kind === 'continue') {
          steps[nodeId] = { output: handled.output };
          continue;
        }
        return handled.result;
      }

      const result = await this.#runNode({
        run,
        node,
        definition,
        config,
        policy,
        firstAttempt: attempt,
        signal,
      });
      if (result.kind === 'aborted') return this.#abortedResult(signal);
      if (result.kind === 'failed') return { kind: 'failed', error: result.error };
      steps[nodeId] = { output: result.output };
    }

    return { kind: 'succeeded' };
  }

  /**
   * Reaches a Breakpoint for the first time. A disabled one is recorded as Skipped. An enabled one
   * resolves and masks its successor input, then pauses the Run in one transaction that also
   * releases the job lease, after which this worker holds nothing for the Run.
   */
  async #breakpoint(input: {
    run: Run;
    job: Job;
    node: TestNode;
    attempt: number;
    config: JsonValue;
    order: readonly string[];
    index: number;
    nodes: Map<string, TestNode>;
    base: Pick<ExpressionContext, 'testData' | 'environment' | 'global'>;
    variables: Record<string, JsonValue>;
    steps: ExpressionContext['steps'];
    logger: Logger;
  }): Promise<{ kind: 'continue'; output: JsonValue } | { kind: 'done'; result: FlowResult }> {
    const { run, job, node, attempt, logger } = input;
    const { infra, registry } = this.#deps;
    const limits = this.#limits(run);
    const parameters = input.config as { enabled?: unknown; message?: unknown };

    if (parameters.enabled === false) {
      const output = { ...breakpointOutput({ enabled: false }), skipped: true, reason: 'disabled' };
      await this.#steps.recordSkipped(run, node, attempt, input.config, output, 'disabled', limits);
      logger.info('Breakpoint is disabled; continuing', { nodeId: node.id });
      return { kind: 'continue', output };
    }

    const row = await this.#steps.beginBreakpoint(run, node, attempt, input.config, limits);
    const output = breakpointOutput({ enabled: true });

    const nextId = input.order[input.index + 1];
    const next = nextId === undefined ? undefined : input.nodes.get(nextId);
    let nextPreview: JsonValue | undefined;
    let nextArtifactId: string | undefined;
    if (next) {
      const nextDefinition = registry.require(next.type);
      let nextConfig: JsonValue;
      try {
        nextConfig = resolveValue(next.parameters, {
          ...input.base,
          variables: input.variables,
          steps: { ...input.steps, [node.id]: { output } },
        });
      } catch (error) {
        const info = this.#safeError(error, 'The next Step input could not be resolved.');
        await this.#steps.failOpen(row, info);
        return { kind: 'done', result: { kind: 'failed', error: this.#stepFailure(next, info) } };
      }
      const preview = this.#steps.preview(
        nextConfig,
        nextDefinition.sensitivePaths ?? [],
        limits.payloadBytes,
      );
      nextPreview = preview.value;
      if (preview.truncated) {
        // The full masked input is kept as an artifact so the inspector can show all of it.
        try {
          const stored = await infra.artifacts.write({
            runId: run.id,
            stepRunId: row.id,
            content: JSON.stringify(preview.masked),
            contentType: 'application/json',
          });
          nextArtifactId = stored.id;
        } catch (cause) {
          logger.warn('The full next-Step input could not be stored as an artifact', {
            code: cause instanceof PlatformError ? cause.code : 'SYSTEM_INTERNAL',
          });
        }
      }
    }

    const message =
      typeof parameters.message === 'string' && parameters.message.length > 0
        ? infra.redactor.redactText(parameters.message).slice(0, BREAKPOINT_MESSAGE_MAX_LENGTH)
        : undefined;
    const paused = await infra.pauses.pauseRun({
      runId: run.id,
      jobId: job.id,
      workerId: this.#deps.config.workerId,
      breakpointStepRunId: row.id,
      pause: {
        breakpointNodeId: node.id,
        ...(message !== undefined ? { message } : {}),
        nextNodeId: next?.id ?? null,
        ...(next ? { nextNodeName: next.name, nextNodeType: next.type } : {}),
        ...(nextPreview !== undefined ? { nextResolvedInputPreview: nextPreview } : {}),
        ...(nextArtifactId ? { nextInputArtifactId: nextArtifactId } : {}),
        pausedAt: this.#now(),
      },
    });

    if (paused.outcome === 'applied') return { kind: 'done', result: { kind: 'paused' } };
    switch (paused.reason) {
      case 'lease-lost':
        return { kind: 'done', result: { kind: 'abandoned' } };
      case 'run-not-running':
        // A cancellation won the race: the attempt closes and the successor never starts.
        await this.#steps.markCancelled(row);
        return { kind: 'done', result: { kind: 'cancelled' } };
      case 'step-not-running': {
        const error: ErrorInfo = {
          code: 'EXECUTION_INVALID_TRANSITION',
          message: 'The Breakpoint attempt changed state while the Run was pausing.',
        };
        return { kind: 'done', result: { kind: 'failed', error } };
      }
    }
  }

  /**
   * Continues a Run whose Breakpoint attempt is still Paused: the pause for the previous
   * continuation generation must be this attempt and must already be resumed.
   */
  async #continueBreakpoint(
    run: Run,
    node: TestNode,
    step: StepRun,
    logger: Logger,
  ): Promise<{ kind: 'continue'; output: JsonValue } | { kind: 'failed'; error: ErrorInfo }> {
    const generation = run.continuationGeneration ?? 0;
    const pause =
      generation > 0 ? await this.#deps.infra.pauses.getPause(run.id, generation - 1) : undefined;
    if (!pause || pause.breakpointStepRunId !== step.id || !pause.resumedAt || pause.cancelledAt) {
      return {
        kind: 'failed',
        error: {
          code: 'EXECUTION_STALE_CONTINUATION',
          message: `The Run was not resumed from Breakpoint "${node.name}" (${node.id}).`,
        },
      };
    }
    const output = breakpointOutput({ enabled: true });
    await this.#steps.completeBreakpoint(step, output);
    logger.info('Breakpoint released; continuing', { nodeId: node.id, generation });
    this.#metrics.increment(METRICS.runsResumed);
    return { kind: 'continue', output };
  }

  #abortedResult(signal: AbortSignal): FlowResult {
    // Interrupts carry a string reason; a bare cancel() aborts with a DOMException.
    return typeof signal.reason === 'string' ? { kind: 'interrupted' } : { kind: 'cancelled' };
  }

  #policy(node: TestNode, supportsRetry: boolean | undefined, run: Run): EffectiveRetryPolicy {
    const policy = effectiveRetryPolicy(node.execution?.retry, run.snapshots.environment.limits);
    policy.maxAttempts = supportsRetry === false ? 1 : Math.max(policy.maxAttempts, 1);
    return policy;
  }

  #limits(run: Run): StepLimits {
    const limits = run.snapshots.environment.limits;
    const artifactBytes = limits?.maxArtifactBytes ?? this.#deps.config.maxArtifactBytes;
    return {
      payloadBytes: limits?.maxPayloadCaptureBytes ?? this.#deps.config.defaultPayloadCaptureBytes,
      ...(artifactBytes !== undefined ? { artifactBytes } : {}),
    };
  }

  async #runNode(input: {
    run: Run;
    node: TestNode;
    definition: ReturnType<StepRegistry['require']>;
    config: JsonValue;
    policy: EffectiveRetryPolicy;
    firstAttempt: number;
    signal: AbortSignal;
  }): Promise<NodeResult> {
    const { run, node, definition, config, policy, signal } = input;
    const maxSeconds = run.snapshots.environment.limits?.maxStepTimeoutSeconds;
    const seconds = Math.min(
      node.execution?.timeoutSeconds ?? this.#deps.config.defaultStepTimeoutSeconds,
      maxSeconds ?? Number.POSITIVE_INFINITY,
    );
    const timeoutMs = Math.max(Math.round(seconds * 1000), 1);

    for (let attempt = input.firstAttempt; ; attempt += 1) {
      const outcome = await this.#steps.runAttempt({
        run,
        node,
        definition,
        config,
        attempt,
        timeoutMs,
        signal,
        limits: this.#limits(run),
        willRetry: (error) => shouldRetry(attempt, policy, isRetryableCode(error.code)),
      });

      if (outcome.kind === 'succeeded') return { kind: 'succeeded', output: outcome.output };
      if (outcome.kind === 'aborted') {
        await this.#recordAbort(outcome.stepRunId, signal);
        return { kind: 'aborted' };
      }
      if (!outcome.retrying) {
        return { kind: 'failed', error: this.#stepFailure(node, outcome.error) };
      }

      const delayMs = computeBackoffMs(attempt, policy);
      this.#metrics.increment(METRICS.stepRetries, { type: node.type });
      this.#deps.logger.info('Step will be retried', {
        runId: run.id,
        nodeId: node.id,
        attempt,
        delayMs,
      });
      try {
        await cancellableSleep(delayMs, signal);
      } catch (error) {
        if (error instanceof PlatformError && error.code === 'EXECUTION_CANCELLED') {
          await this.#recordAbort(outcome.stepRunId, signal);
          return { kind: 'aborted' };
        }
        throw error;
      }
    }
  }

  /** A user cancellation closes the open attempt; a shutdown leaves it for the resuming worker. */
  async #recordAbort(stepRunId: string, signal: AbortSignal): Promise<void> {
    if (typeof signal.reason === 'string') return;
    const step = await this.#deps.infra.runs.getStepRun(stepRunId);
    if (step) await this.#steps.markCancelled(step);
  }

  #stepFailure(node: TestNode, error: ErrorInfo | undefined): ErrorInfo {
    const cause = error ?? { code: 'SYSTEM_INTERNAL' as const, message: 'The Step failed.' };
    return {
      ...cause,
      message: `Step "${node.name}" (${node.id}) failed: ${cause.message}`,
    };
  }

  #safeError(error: unknown, fallback: string): ErrorInfo {
    const info = toErrorInfo(error);
    return info.code === 'SYSTEM_INTERNAL' ? { ...info, message: fallback } : info;
  }

  async #finalize(
    run: Run,
    status: 'Succeeded' | 'Failed' | 'Cancelled',
    error?: ErrorInfo,
  ): Promise<void> {
    const { infra, logger } = this.#deps;
    let target = status;
    let reason = error;

    if (target !== 'Cancelled') {
      // A cancellation that arrived after the last Step still wins: the transition below would
      // be rejected for a Run that is Cancelling.
      const current = await infra.runs.getRun(run.id);
      if (current && isCancellationRequested(current)) {
        target = 'Cancelled';
        reason = undefined;
      }
    }

    const safe = reason
      ? {
          ...reason,
          message: infra.redactor.redactText(reason.message),
          ...(reason.detail ? { detail: infra.redactor.redactText(reason.detail) } : {}),
        }
      : undefined;

    if (target === 'Cancelled') {
      // A Breakpoint attempt still Paused when the Run is cancelled is closed with it.
      for (const step of await infra.runs.listStepRuns(run.id)) {
        if (step.status === 'Paused') await this.#steps.markCancelled(step);
      }
    }

    await this.#emitter.runStatus(run.id, target);
    const result = await infra.runs.transitionRun(run.id, {
      from: target === 'Cancelled' ? 'Cancelling' : 'Running',
      to: target,
      at: this.#now(),
      ...(safe ? { error: safe } : {}),
    });

    if (result.outcome === 'rejected') {
      if (target !== 'Cancelled' && result.current?.status === 'Cancelling') {
        await this.#finalize(run, 'Cancelled');
        return;
      }
      logger.warn('Run could not be moved to its final state', {
        runId: run.id,
        wanted: target,
        current: result.current?.status,
      });
      return;
    }
    logger.info('Run finished', { runId: run.id, status: target, code: safe?.code });
    this.#metrics.increment(METRICS.runsFinished, { status: target });
  }
}

/** JSON with sorted object keys, so equal values always compare equal as text. */
const stableJson = (value: JsonValue): string => {
  const sort = (node: JsonValue): JsonValue => {
    if (Array.isArray(node)) return node.map(sort);
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(
        Object.keys(node)
          .sort()
          .map((key) => [key, sort((node as Record<string, JsonValue>)[key] as JsonValue)]),
      );
    }
    return node;
  };
  return JSON.stringify(sort(value));
};
