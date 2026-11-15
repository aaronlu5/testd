import { randomUUID } from 'node:crypto';
import {
  isSensitiveKey,
  planSuiteRerun,
  buildSuiteRunPlan,
  isTerminalSuiteRunStatus,
  computeGlobals,
  mockSetupIdsOf,
  resolveTestData,
  resolveVariables,
  PlatformError,
  type Clock,
} from '@test-platform/core';
import type {
  JsonValue,
  SuiteRun,
  SuiteRunItemView,
  SuiteRunStatus,
  SuiteRunUpdatedEvent,
  SuiteRunView,
  TestDataAsset,
  TestDefinition,
  ValidationIssue,
} from '@test-platform/contracts';
import type { LocalInfrastructure } from '@test-platform/infrastructure-local';
import { notFound } from '../errors.js';
import { loadMockSetups } from './mock-setups.js';
import type { DefinitionService } from './definition-service.js';
import type { EnvironmentService } from './environment-service.js';
import { reportToError, type ValidationService } from './validation-service.js';

export type CreateSuiteRunInput = {
  suiteId: string;
  suiteVersion?: number;
  environmentId: string;
  /** Requested concurrency; must not exceed the Environment's maxSuiteConcurrency (default 1). */
  maxConcurrency?: number;
  variableOverrides?: Record<string, JsonValue>;
};

type Deps = {
  definitions: DefinitionService;
  environments: EnvironmentService;
  validation: ValidationService;
  infra: Pick<LocalInfrastructure, 'suiteRuns' | 'suiteCommands' | 'events'>;
  clock: Clock;
};

/**
 * Creates, reads, cancels and reruns Suite Runs. It only validates and stores: child Test Runs
 * are created later by the worker's scheduler, and no Step is executed here.
 */
export class SuiteRunService {
  readonly #deps: Deps;

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  /** Validates every referenced Test against the Environment, then stores the parent and children. */
  async create(input: CreateSuiteRunInput, actor: string): Promise<SuiteRunView> {
    const { environments, validation } = this.#deps;
    const environment = await environments.require(input.environmentId);
    const suite = await this.#reference('suite', input.suiteId, input.suiteVersion);

    // Bounded concurrency is an Environment policy: an explicit request above it is refused
    // rather than quietly reduced, so nobody believes they are running in parallel.
    const ceiling = environment.limits?.maxSuiteConcurrency ?? 1;
    if (input.maxConcurrency !== undefined && input.maxConcurrency > ceiling) {
      throw new PlatformError(
        'VALIDATION_TARGET_POLICY',
        `Environment "${environment.id}" allows at most ${ceiling} concurrent Suite item(s); ${input.maxConcurrency} was requested.`,
        {
          issues: [
            {
              path: '/maxConcurrency',
              message: `Exceeds the environment limit of ${ceiling}.`,
              keyword: 'target-policy',
            },
          ],
        },
      );
    }

    const overrides = input.variableOverrides ?? {};
    const sensitive = Object.keys(overrides).filter((key) => isSensitiveKey(key));
    if (sensitive.length > 0) {
      throw new PlatformError('VALIDATION_SCHEMA', 'Variable overrides must be non-secret.', {
        issues: sensitive.map((key) => ({
          path: `/variableOverrides/${key}`,
          message: 'Secrets must not be passed as variable overrides.',
          keyword: 'secret',
        })),
      });
    }

    const tests: TestDefinition[] = [];
    const testData: TestDataAsset[] = [];
    const issues: ValidationIssue[] = [];
    for (const [index, item] of suite.asset.items.entries()) {
      const test = await this.#reference('test', item.testId, item.testVersion);
      const data = await this.#reference('test-data', item.dataSetId, item.dataSetVersion);
      const report = validation.validateTest(test.asset, environment);
      if (!report.valid) {
        issues.push(
          ...report.issues.map((issue) => ({
            ...issue,
            path: `/items/${index}${issue.path}`,
          })),
        );
      }
      try {
        const sampleGlobals = computeGlobals({
          runId: randomUUID(),
          runNumber: 1,
          requestedAt: this.#deps.clock.now().toISOString(),
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
      } catch {
        issues.push({
          path: `/items/${index}`,
          message: 'Variables for this item cannot be resolved with the selected Test Data.',
          keyword: 'expression',
        });
      }
      tests.push(test.asset);
      testData.push(data.asset);
    }
    if (issues.length > 0) {
      throw reportToError(
        { valid: false, issues, order: [] },
        'The Suite cannot be run because one or more Tests are not valid.',
      );
    }

    const mockSetups = await loadMockSetups(
      this.#deps.definitions,
      mockSetupIdsOf(suite.asset.helpers, ...tests.map((test) => test.helpers)),
    );

    const at = this.#deps.clock.now().toISOString();
    const plan = buildSuiteRunPlan({
      suite: suite.asset,
      tests,
      testData,
      environment,
      mockSetups,
      requestedBy: actor,
      requestedAt: at,
      requestedConcurrency: input.maxConcurrency,
      variableOverrides: structuredClone(overrides),
      newId: randomUUID,
    });
    await this.#deps.infra.suiteCommands.submit(plan, {
      actor,
      action: 'suiteRun.create',
      entityType: 'suite-run',
      entityId: plan.suiteRun.id,
      at,
      metadata: {
        suiteId: suite.asset.id,
        suiteVersion: suite.asset.version,
        environmentId: environment.id,
        maxConcurrency: plan.suiteRun.maxConcurrency,
        items: plan.items.length,
      },
    });
    return this.get(plan.suiteRun.id);
  }

  async get(id: string): Promise<SuiteRunView> {
    const { suiteRuns, events } = this.#deps.infra;
    // Sequence first, as for Runs: reconnecting clients may repeat events but never miss one.
    const lastEventSeq = await events.lastSeq(id);
    const suiteRun = await suiteRuns.getSuiteRun(id);
    if (!suiteRun) throw notFound(`Suite Run "${id}"`);
    return this.#view(suiteRun, lastEventSeq);
  }

  async list(filter: { status?: SuiteRunStatus; limit?: number; offset?: number }) {
    const { suiteRuns } = this.#deps.infra;
    const runs = await suiteRuns.listSuiteRuns(filter);
    return Promise.all(
      runs.map(async (run) => {
        const view = await this.#view(run, 0);
        const summary: Partial<SuiteRunView> = { ...view };
        delete summary.items;
        return summary;
      }),
    );
  }

  async cancel(id: string, actor: string): Promise<SuiteRunView> {
    const { suiteCommands } = this.#deps.infra;
    const existing = await this.get(id);
    const at = this.#deps.clock.now().toISOString();
    const result = await suiteCommands.requestCancel({
      suiteRunId: id,
      at,
      audit: { actor, action: 'suiteRun.cancel', entityType: 'suite-run', entityId: id, at },
    });
    if (result.outcome === 'rejected') {
      throw new PlatformError(
        'VALIDATION_CONFLICT',
        `Suite Run "${id}" is already ${result.current?.status ?? existing.status} and cannot be cancelled.`,
      );
    }
    return this.get(id);
  }

  /** A new Suite Run from the stored snapshots of a finished one; live definitions are not read. */
  async rerun(id: string, actor: string): Promise<SuiteRunView> {
    const { suiteRuns, suiteCommands } = this.#deps.infra;
    const source = await suiteRuns.getSuiteRun(id);
    if (!source) throw notFound(`Suite Run "${id}"`);
    if (!isTerminalSuiteRunStatus(source.status)) {
      throw new PlatformError(
        'VALIDATION_CONFLICT',
        `Suite Run "${id}" is still ${source.status}; wait for it to finish before rerunning.`,
      );
    }
    const at = this.#deps.clock.now().toISOString();
    const plan = planSuiteRerun(source, {
      requestedBy: actor,
      requestedAt: at,
      newId: randomUUID,
    });
    await suiteCommands.submit(plan, {
      actor,
      action: 'suiteRun.rerun',
      entityType: 'suite-run',
      entityId: plan.suiteRun.id,
      at,
      metadata: { rerunOfSuiteRunId: source.id },
    });
    return this.get(plan.suiteRun.id);
  }

  async currentStatus(id: string): Promise<SuiteRunStatus | undefined> {
    return (await this.#deps.infra.suiteRuns.getSuiteRun(id))?.status;
  }

  events(id: string, afterSeq: number, limit: number): Promise<SuiteRunUpdatedEvent[]> {
    return this.#deps.infra.events.listSuiteSince(id, afterSeq, limit);
  }

  async #view(suiteRun: SuiteRun, lastEventSeq: number): Promise<SuiteRunView> {
    const { suiteRuns } = this.#deps.infra;
    const { snapshots, ...summary } = suiteRun;
    const testNames = new Map(snapshots.tests.map((t) => [`${t.id}@${t.version}`, t.name]));
    const dataNames = new Map(snapshots.testData.map((d) => [`${d.id}@${d.version}`, d.name]));
    const items: SuiteRunItemView[] = (await suiteRuns.listItems(suiteRun.id)).map((item) => ({
      ...item,
      testName: testNames.get(`${item.test.id}@${item.test.version}`) ?? item.test.id,
      dataSetName:
        dataNames.get(`${item.testData.id}@${item.testData.version}`) ?? item.testData.id,
    }));
    return {
      ...summary,
      suiteName: snapshots.suite.name,
      counts: await suiteRuns.counts(suiteRun.id),
      items,
      lastEventSeq,
    };
  }

  async #reference<T extends 'suite' | 'test' | 'test-data'>(
    type: T,
    id: string,
    version?: number,
  ) {
    try {
      return await this.#deps.definitions.get(type, id, version);
    } catch (error) {
      if (error instanceof PlatformError && error.code === 'VALIDATION_NOT_FOUND') {
        throw new PlatformError('VALIDATION_REFERENCE', error.message);
      }
      throw error;
    }
  }
}
