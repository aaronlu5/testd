import { randomUUID } from 'node:crypto';
import type { JsonValue, Run, RunSummary, ValidationIssue } from '@test-platform/contracts';
import {
  PlatformError,
  isPlatformError,
  isSensitiveKey,
  isTerminalRunStatus,
  computeGlobals,
  mockSetupIdsOf,
  resolveTestData,
  resolveVariables,
  type Clock,
  type RunCommands,
  type RunPauseRepository,
  type RunRepository,
  notPausedError,
  staleContinuationError,
} from '@test-platform/core';
import { notFound } from '../errors.js';
import type { DefinitionService } from './definition-service.js';
import type { EnvironmentService } from './environment-service.js';
import { loadMockSetups } from './mock-setups.js';
import { reportToError, type ValidationService } from './validation-service.js';

export type CreateRunInput = {
  testId: string;
  testVersion?: number;
  dataSetId: string;
  dataSetVersion?: number;
  environmentId: string;
  variableOverrides?: Record<string, JsonValue>;
};

export type RunServiceDeps = {
  definitions: DefinitionService;
  environments: EnvironmentService;
  validation: ValidationService;
  commands: RunCommands;
  runs: RunRepository;
  pauses: RunPauseRepository;
  clock: Clock;
};

export type ResumeResult = {
  run: RunSummary;
  /** Generation the Run continues under (the one after the pause that was resumed). */
  continuationGeneration: number;
  /** True when this request repeated a resume that had already been accepted. */
  alreadyResumed: boolean;
};

export const toSummary = (run: Run): RunSummary => {
  const summary: Partial<Run> = { ...run };
  delete summary.snapshots;
  return summary as RunSummary;
};

/** Creates, reruns, and cancels Runs. Nothing here executes a Step; the worker does that. */
export class RunService {
  readonly #deps: RunServiceDeps;

  constructor(deps: RunServiceDeps) {
    this.#deps = deps;
  }

  /** Validates references and inputs, freezes snapshots, and queues the Run atomically. */
  async create(input: CreateRunInput, actor: string): Promise<RunSummary> {
    const environment = await this.#deps.environments.require(input.environmentId);
    const test = await this.#reference('test', input.testId, input.testVersion);
    const data = await this.#reference('test-data', input.dataSetId, input.dataSetVersion);

    const report = this.#deps.validation.validateTest(test.asset, environment);
    if (!report.valid)
      throw reportToError(report, 'The Test cannot be run because it is not valid.');

    const overrides = input.variableOverrides ?? {};
    const sensitive = Object.keys(overrides).filter((key) => isSensitiveKey(key));
    if (sensitive.length > 0) {
      const issues: ValidationIssue[] = sensitive.map((key) => ({
        path: `/variableOverrides/${key}`,
        message: 'Secrets must not be passed as variable overrides.',
        keyword: 'secret',
      }));
      throw new PlatformError('VALIDATION_SCHEMA', 'Variable overrides must be non-secret.', {
        issues,
      });
    }
    // Dry-run so missing Test Data fields or unknown overrides fail now, not inside the worker.
    const mockSetups = await loadMockSetups(
      this.#deps.definitions,
      mockSetupIdsOf(test.asset.helpers),
    );

    const now = this.#deps.clock.now().toISOString();
    const sampleGlobals = computeGlobals({
      runId: randomUUID(),
      runNumber: 1,
      requestedAt: now,
      testId: test.asset.id,
      testVersion: test.asset.version,
      environmentId: environment.id,
      environmentClassification: environment.classification,
    });
    resolveVariables(
      test.asset.variables,
      {
        testData: resolveTestData(data.asset.data, sampleGlobals),
        environment: environment.values ?? {},
        global: sampleGlobals,
      },
      overrides,
    );

    const run: Run = {
      id: randomUUID(),
      kind: 'test',
      status: 'Queued',
      environmentId: environment.id,
      requestedBy: actor,
      requestedAt: now,
      test: { id: test.asset.id, version: test.asset.version },
      testData: { id: data.asset.id, version: data.asset.version },
      variableOverrides: structuredClone(overrides),
      snapshots: structuredClone({
        test: test.asset,
        testData: data.asset,
        environment,
        ...(mockSetups.length > 0 ? { mockSetups } : {}),
      }),
    };
    const submitted = await this.#deps.commands.submit({
      run,
      audit: {
        actor,
        action: 'run.create',
        entityType: 'run',
        entityId: run.id,
        at: now,
        metadata: {
          testId: run.test?.id ?? '',
          testVersion: run.test?.version ?? 0,
          dataSetId: run.testData?.id ?? '',
          environmentId: environment.id,
        },
      },
    });
    return toSummary(submitted.run);
  }

  /** Queues a new Run from the stored snapshots; live definitions are not consulted. */
  async rerun(sourceId: string, actor: string): Promise<RunSummary> {
    const source = await this.#deps.runs.getRun(sourceId);
    if (!source) throw notFound(`Run "${sourceId}"`);
    if (source.kind !== 'test') {
      throw new PlatformError('VALIDATION_CONFLICT', 'Only Test Runs can be rerun.');
    }
    if (!isTerminalRunStatus(source.status)) {
      throw new PlatformError(
        'VALIDATION_CONFLICT',
        `Run "${sourceId}" is still ${source.status}; wait for it to finish before rerunning.`,
      );
    }

    const now = this.#deps.clock.now().toISOString();
    const run: Run = {
      id: randomUUID(),
      kind: source.kind,
      status: 'Queued',
      environmentId: source.environmentId,
      requestedBy: actor,
      requestedAt: now,
      rerunOfRunId: source.id,
      test: source.test,
      testData: source.testData,
      variableOverrides: structuredClone(source.variableOverrides),
      snapshots: structuredClone(source.snapshots),
    };
    const submitted = await this.#deps.commands.submit({
      run,
      audit: {
        actor,
        action: 'run.rerun',
        entityType: 'run',
        entityId: run.id,
        at: now,
        metadata: { rerunOfRunId: source.id },
      },
    });
    return toSummary(submitted.run);
  }

  /**
   * Resumes a Run paused at a Breakpoint. Idempotent for one continuation generation: repeating
   * the request returns the same accepted continuation and queues nothing more. Resume takes no
   * overrides: the Run continues from its immutable snapshot.
   */
  async resume(id: string, actor: string, expectedGeneration?: number): Promise<ResumeResult> {
    const existing = await this.#deps.runs.getRun(id);
    if (!existing) throw notFound(`Run "${id}"`);

    const at = this.#deps.clock.now().toISOString();
    const result = await this.#deps.pauses.resumeRun({
      runId: id,
      at,
      expectedGeneration,
      audit: {
        actor,
        action: 'run.resume',
        entityType: 'run',
        entityId: id,
        at,
        metadata: {
          continuationGeneration: expectedGeneration ?? existing.continuationGeneration ?? 0,
        },
      },
    });

    if (result.outcome === 'rejected') {
      if (result.reason === 'not-found') throw notFound(`Run "${id}"`);
      if (result.reason === 'stale-generation') throw staleContinuationError();
      const error = notPausedError();
      throw new PlatformError(
        error.code,
        `Run "${id}" is ${result.run?.status ?? existing.status}, not paused.`,
      );
    }
    return {
      run: toSummary(result.run),
      continuationGeneration: result.run.continuationGeneration ?? 0,
      alreadyResumed: result.outcome === 'noop',
    };
  }

  async cancel(id: string, actor: string): Promise<RunSummary> {
    const existing = await this.#deps.runs.getRun(id);
    if (!existing) throw notFound(`Run "${id}"`);

    const at = this.#deps.clock.now().toISOString();
    const result = await this.#deps.commands.requestCancel({
      runId: id,
      at,
      audit: { actor, action: 'run.cancel', entityType: 'run', entityId: id, at },
    });
    if (result.outcome === 'rejected' || !result.current) {
      throw new PlatformError(
        'VALIDATION_CONFLICT',
        `Run "${id}" is already ${result.current?.status ?? existing.status} and cannot be cancelled.`,
      );
    }
    return toSummary(result.current);
  }

  async #reference<T extends 'test' | 'test-data'>(type: T, id: string, version?: number) {
    try {
      return await this.#deps.definitions.get(type, id, version);
    } catch (error) {
      if (isPlatformError(error) && error.code === 'VALIDATION_NOT_FOUND') {
        throw new PlatformError('VALIDATION_REFERENCE', error.message);
      }
      throw error;
    }
  }
}
