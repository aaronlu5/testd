import type {
  EnvironmentConfig,
  Helpers,
  JsonValue,
  MockSetupAsset,
  Run,
  SuiteAsset,
  SuiteRun,
  SuiteRunItem,
  SuiteRunSnapshots,
  TestDataAsset,
  TestDefinition,
} from '@test-platform/contracts';
import { PlatformError } from './errors.js';
import type { NewSuiteRun } from './ports.js';
import { effectiveSuiteConcurrency } from './suite.js';

export type SuitePlanInput = {
  suite: SuiteAsset;
  /** Candidate Test versions; each Suite item resolves to one of these. */
  tests: readonly TestDefinition[];
  /** Candidate Test Data versions. */
  testData: readonly TestDataAsset[];
  environment: EnvironmentConfig;
  /** Candidate Mock API setups; every setup named by the Suite or its Tests must be among them. */
  mockSetups?: readonly MockSetupAsset[];
  requestedBy: string;
  requestedAt: string;
  /** Concurrency the caller asks for; defaults to the Suite maxConcurrency, then 1. */
  requestedConcurrency?: number;
  variableOverrides?: Record<string, JsonValue>;
  newId: () => string;
};

/** The ids of the Mock API setups named by the given helpers, in order and without repeats. */
export const mockSetupIdsOf = (...helpers: (Helpers | undefined)[]): string[] => [
  ...new Set(helpers.flatMap((item) => item?.mockApi?.setupIds ?? [])),
];

const pick = <T extends { id: string; version: number }>(
  candidates: readonly T[],
  id: string,
  version: number | undefined,
  label: string,
): T => {
  const matching = candidates.filter((asset) => asset.id === id);
  const chosen =
    version === undefined
      ? matching.reduce<T | undefined>(
          (best, asset) => (!best || asset.version > best.version ? asset : best),
          undefined,
        )
      : matching.find((asset) => asset.version === version);
  if (!chosen) {
    throw new PlatformError(
      'VALIDATION_REFERENCE',
      `${label} "${id}"${version === undefined ? '' : ` version ${version}`} was not found for the Suite Run.`,
    );
  }
  return chosen;
};

/**
 * Snapshots the Suite, every referenced Test and Test Data version, and the Environment, and lays
 * out one Pending child per Suite item in Suite order. Later edits to live definitions never
 * reach the Suite Run.
 */
export const buildSuiteRunPlan = (input: SuitePlanInput): NewSuiteRun => {
  const { suite, environment } = input;
  const maxSize = environment.limits?.maxSuiteSize;
  if (maxSize !== undefined && suite.items.length > maxSize) {
    throw new PlatformError(
      'VALIDATION_TARGET_POLICY',
      `The Suite has ${suite.items.length} items; environment "${environment.id}" allows ${maxSize}.`,
    );
  }

  const tests = new Map<string, TestDefinition>();
  const data = new Map<string, TestDataAsset>();
  const suiteRunId = input.newId();
  const mockPool = input.mockSetups ?? [];
  const items: SuiteRunItem[] = suite.items.map((item, position) => {
    const test = pick(input.tests, item.testId, item.testVersion, 'Test');
    const dataSet = pick(input.testData, item.dataSetId, item.dataSetVersion, 'Test Data');
    tests.set(`${test.id}@${test.version}`, test);
    data.set(`${dataSet.id}@${dataSet.version}`, dataSet);
    return {
      id: input.newId(),
      suiteRunId,
      position,
      test: { id: test.id, version: test.version },
      testData: { id: dataSet.id, version: dataSet.version },
      status: 'Pending',
    };
  });

  const wantedSetups = mockSetupIdsOf(
    suite.helpers,
    ...[...tests.values()].map((test) => test.helpers),
  );
  const mockSetups = wantedSetups.map((id) => pick(mockPool, id, undefined, 'Mock API setup'));

  const suiteRun: SuiteRun = {
    id: suiteRunId,
    status: 'Queued',
    environmentId: environment.id,
    suite: { id: suite.id, version: suite.version },
    requestedBy: input.requestedBy,
    requestedAt: input.requestedAt,
    maxConcurrency: effectiveSuiteConcurrency(
      input.requestedConcurrency ?? suite.maxConcurrency,
      environment.limits?.maxSuiteConcurrency,
    ),
    variableOverrides: input.variableOverrides ?? {},
    snapshots: {
      suite,
      tests: [...tests.values()],
      testData: [...data.values()],
      environment,
      ...(mockSetups.length > 0 ? { mockSetups } : {}),
    },
  };
  return { suiteRun, items };
};

const latestVersion = <T extends { id: string; version: number }>(
  list: readonly T[],
  id: string,
): number | undefined =>
  list.filter((asset) => asset.id === id).reduce((max, asset) => Math.max(max, asset.version), 0) ||
  undefined;

/**
 * A new Suite Run from a previous one, using only its stored snapshots; nothing is re-read from
 * live definitions. Items that left their versions open keep the version the original resolved.
 */
export const planSuiteRerun = (
  original: Pick<SuiteRun, 'id' | 'snapshots' | 'variableOverrides' | 'maxConcurrency'>,
  options: {
    requestedBy: string;
    requestedAt: string;
    newId: () => string;
    /** Defaults to the original effective concurrency. */
    requestedConcurrency?: number;
  },
): NewSuiteRun => {
  const { suite, tests, testData, environment } = original.snapshots;
  const plan = buildSuiteRunPlan({
    suite: {
      ...suite,
      items: suite.items.map((item) => ({
        ...item,
        testVersion: item.testVersion ?? latestVersion(tests, item.testId),
        dataSetVersion: item.dataSetVersion ?? latestVersion(testData, item.dataSetId),
      })),
    },
    tests,
    testData,
    environment,
    mockSetups: original.snapshots.mockSetups,
    requestedBy: options.requestedBy,
    requestedAt: options.requestedAt,
    requestedConcurrency: options.requestedConcurrency ?? original.maxConcurrency,
    variableOverrides: original.variableOverrides,
    newId: options.newId,
  });
  plan.suiteRun.rerunOfSuiteRunId = original.id;
  return plan;
};

/** The child Test Run for one Suite item, built only from the Suite Run snapshots. */
export const buildChildRun = (
  suiteRun: Pick<SuiteRun, 'environmentId' | 'requestedBy' | 'variableOverrides'> & {
    snapshots: SuiteRunSnapshots;
  },
  item: Pick<SuiteRunItem, 'test' | 'testData'>,
  options: { id: string; at: string },
): Run => {
  const test = suiteRun.snapshots.tests.find(
    (candidate) => candidate.id === item.test.id && candidate.version === item.test.version,
  );
  const testData = suiteRun.snapshots.testData.find(
    (candidate) => candidate.id === item.testData.id && candidate.version === item.testData.version,
  );
  if (!test || !testData) {
    throw new PlatformError(
      'VALIDATION_REFERENCE',
      'The Suite Run snapshot is missing a Test or Test Data version.',
    );
  }
  // Suite-level setups come first, so they answer before a Test's own.
  const ids = mockSetupIdsOf(suiteRun.snapshots.suite.helpers, test.helpers);
  const mockSetups = ids.flatMap((id) =>
    (suiteRun.snapshots.mockSetups ?? []).filter((setup) => setup.id === id),
  );
  return {
    id: options.id,
    kind: 'test',
    status: 'Queued',
    environmentId: suiteRun.environmentId,
    requestedBy: suiteRun.requestedBy,
    requestedAt: options.at,
    test: { id: test.id, version: test.version },
    testData: { id: testData.id, version: testData.version },
    variableOverrides: suiteRun.variableOverrides,
    snapshots: {
      test,
      testData,
      environment: suiteRun.snapshots.environment,
      ...(mockSetups.length > 0 ? { mockSetups } : {}),
    },
  };
};
