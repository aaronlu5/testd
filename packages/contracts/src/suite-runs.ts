import type { ErrorInfo } from './errors.js';
import type { AssetRef } from './runs.js';
import type { EnvironmentConfig } from './environment.js';
import type { MockSetupAsset, SuiteAsset, TestDataAsset, TestDefinition } from './assets.js';
import type { JsonValue } from './json.js';

export const SUITE_RUN_STATUSES = [
  'Queued',
  'Running',
  /** At least one child is paused at a Breakpoint and no further child can be dispatched. */
  'WaitingForBreakpoint',
  'Cancelling',
  'Succeeded',
  'Failed',
  'Cancelled',
] as const;
export type SuiteRunStatus = (typeof SUITE_RUN_STATUSES)[number];

export const SUITE_RUN_ITEM_STATUSES = [
  /** Not dispatched yet. */
  'Pending',
  'Queued',
  'Running',
  'Paused',
  'Cancelling',
  'Succeeded',
  'Failed',
  'Cancelled',
  /** Never dispatched because the Suite Run was cancelled first. */
  'Skipped',
] as const;
export type SuiteRunItemStatus = (typeof SUITE_RUN_ITEM_STATUSES)[number];

export type SuiteRunItem = {
  id: string;
  suiteRunId: string;
  /** Zero-based position in the Suite's item list. */
  position: number;
  test: AssetRef;
  testData: AssetRef;
  /** Child Test Run, once dispatched. */
  runId?: string;
  status: SuiteRunItemStatus;
  dispatchedAt?: string;
  finishedAt?: string;
};

export type SuiteRunCounts = Record<SuiteRunItemStatus, number> & { total: number };

export type SuiteRunSnapshots = {
  suite: SuiteAsset;
  /** Every distinct Test version referenced by the Suite's items. */
  tests: TestDefinition[];
  /** Every distinct Test Data version referenced by the Suite's items. */
  testData: TestDataAsset[];
  environment: EnvironmentConfig;
  /** Every Mock API setup used by the Suite or any of its Tests, frozen with the Suite Run. */
  mockSetups?: MockSetupAsset[];
};

/** Parent record that creates one child Test Run per Suite item from immutable snapshots. */
export type SuiteRun = {
  id: string;
  status: SuiteRunStatus;
  environmentId: string;
  suite: AssetRef;
  requestedBy: string;
  requestedAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelRequestedAt?: string;
  rerunOfSuiteRunId?: string;
  /** Effective concurrency after applying the Environment limit. */
  maxConcurrency: number;
  variableOverrides: Record<string, JsonValue>;
  /** Captured at creation so child Runs never see later edits to live definitions. */
  snapshots: SuiteRunSnapshots;
  error?: ErrorInfo;
};

export type SuiteRunDetail = Omit<SuiteRun, 'snapshots'> & {
  counts: SuiteRunCounts;
  items: SuiteRunItem[];
};

/** Child item as presented by the API, with names taken from the Suite Run snapshot. */
export type SuiteRunItemView = SuiteRunItem & { testName: string; dataSetName: string };

/** API read model: the parent without its snapshots, plus counts and ordered children. */
export type SuiteRunView = Omit<SuiteRun, 'snapshots'> & {
  suiteName: string;
  counts: SuiteRunCounts;
  items: SuiteRunItemView[];
  /** See `RunDetail.lastEventSeq`. */
  lastEventSeq: number;
};
