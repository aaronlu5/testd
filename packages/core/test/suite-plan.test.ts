import { describe, expect, it } from 'vitest';
import type {
  EnvironmentConfig,
  MockSetupAsset,
  SuiteAsset,
  TestDataAsset,
  TestDefinition,
} from '@test-platform/contracts';
import {
  buildChildRun,
  buildSuiteRunPlan,
  decideSuiteItemTransition,
  decideSuiteRunTransition,
  planSuiteRerun,
} from '../src/index.js';

const AT = '2026-01-01T00:00:00.000Z';
const meta = { createdAt: AT, createdBy: 'tester' };
let counter = 0;
const newId = (): string => `id-${(counter += 1)}`;

const test = (id: string, version = 1): TestDefinition => ({
  schemaVersion: 1,
  id,
  version,
  name: `${id}@${version}`,
  tags: [],
  metadata: meta,
  variables: {},
  nodes: [{ id: 'n', type: 'delay', name: 'n', parameters: {} }],
  edges: [],
});
const data = (id: string, version = 1): TestDataAsset => ({
  schemaVersion: 1,
  id,
  version,
  name: id,
  tags: [],
  metadata: meta,
  data: {},
});
const suite = (items: SuiteAsset['items'], maxConcurrency?: number): SuiteAsset => ({
  schemaVersion: 1,
  id: 'suite',
  version: 2,
  name: 'Suite',
  tags: [],
  metadata: meta,
  items,
  ...(maxConcurrency ? { maxConcurrency } : {}),
});
const env = (limits: EnvironmentConfig['limits'] = {}): EnvironmentConfig => ({
  id: 'env',
  name: 'Env',
  classification: 'TEST',
  limits,
  targets: {},
});
const base = { requestedBy: 'tester', requestedAt: AT, newId };

describe('buildSuiteRunPlan', () => {
  it('resolves exact versions, otherwise the highest available, in Suite order', () => {
    const plan = buildSuiteRunPlan({
      ...base,
      suite: suite([
        { testId: 'a', dataSetId: 'd' },
        { testId: 'a', dataSetId: 'd', testVersion: 1 },
        { testId: 'b', dataSetId: 'd', dataSetVersion: 1 },
      ]),
      tests: [test('a', 1), test('a', 3), test('b')],
      testData: [data('d', 1), data('d', 5)],
      environment: env(),
    });
    expect(
      plan.items.map((i) => [i.position, i.test.id, i.test.version, i.testData.version]),
    ).toEqual([
      [0, 'a', 3, 5],
      [1, 'a', 1, 5],
      [2, 'b', 1, 1],
    ]);
    expect(
      plan.items.every((i) => i.status === 'Pending' && i.suiteRunId === plan.suiteRun.id),
    ).toBe(true);
    // Each distinct version is snapshotted once.
    expect(plan.suiteRun.snapshots.tests.map((t) => `${t.id}@${t.version}`)).toEqual([
      'a@3',
      'a@1',
      'b@1',
    ]);
    expect(plan.suiteRun.snapshots.testData.map((d) => d.version)).toEqual([5, 1]);
    expect(plan.suiteRun.suite).toEqual({ id: 'suite', version: 2 });
  });

  it('applies the Suite default and the Environment ceiling to concurrency', () => {
    const make = (suiteMax: number | undefined, requested: number | undefined, limit?: number) =>
      buildSuiteRunPlan({
        ...base,
        suite: suite([{ testId: 'a', dataSetId: 'd' }], suiteMax),
        tests: [test('a')],
        testData: [data('d')],
        environment: env(limit === undefined ? {} : { maxSuiteConcurrency: limit }),
        requestedConcurrency: requested,
      }).suiteRun.maxConcurrency;
    expect(make(undefined, undefined)).toBe(1);
    expect(make(4, undefined)).toBe(1); // no Environment limit: stays sequential
    expect(make(4, undefined, 3)).toBe(3);
    expect(make(4, 2, 3)).toBe(2);
    expect(make(undefined, 9, 3)).toBe(3);
  });

  it('reports missing references and over-long Suites without leaking details', () => {
    expect(() =>
      buildSuiteRunPlan({
        ...base,
        suite: suite([{ testId: 'a', dataSetId: 'd', testVersion: 9 }]),
        tests: [test('a')],
        testData: [data('d')],
        environment: env(),
      }),
    ).toThrow('Test "a" version 9 was not found');
    expect(() =>
      buildSuiteRunPlan({
        ...base,
        suite: suite([
          { testId: 'a', dataSetId: 'd' },
          { testId: 'a', dataSetId: 'd' },
        ]),
        tests: [test('a')],
        testData: [data('d')],
        environment: env({ maxSuiteSize: 1 }),
      }),
    ).toThrow('allows 1');
  });
});

describe('planSuiteRerun and buildChildRun', () => {
  const original = () =>
    buildSuiteRunPlan({
      ...base,
      suite: suite([{ testId: 'a', dataSetId: 'd' }], 2),
      tests: [test('a', 1), test('a', 4)],
      testData: [data('d', 2)],
      environment: env({ maxSuiteConcurrency: 2 }),
      variableOverrides: { region: 'eu' },
    }).suiteRun;

  it('reuses snapshots, versions, overrides and concurrency, linking back to the original', () => {
    const first = original();
    const plan = planSuiteRerun(first, { ...base });
    expect(plan.suiteRun).toMatchObject({
      rerunOfSuiteRunId: first.id,
      maxConcurrency: 2,
      variableOverrides: { region: 'eu' },
      status: 'Queued',
    });
    expect(plan.suiteRun.id).not.toBe(first.id);
    expect(plan.items[0]?.test).toEqual({ id: 'a', version: 4 });
    expect(plan.suiteRun.snapshots.environment).toEqual(first.snapshots.environment);
  });

  it('can lower concurrency on rerun but never above the snapshot Environment limit', () => {
    const first = original();
    expect(
      planSuiteRerun(first, { ...base, requestedConcurrency: 1 }).suiteRun.maxConcurrency,
    ).toBe(1);
    expect(
      planSuiteRerun(first, { ...base, requestedConcurrency: 8 }).suiteRun.maxConcurrency,
    ).toBe(2);
  });

  it('builds a queued child Run purely from the snapshot', () => {
    const first = original();
    const run = buildChildRun(
      first,
      { test: { id: 'a', version: 4 }, testData: { id: 'd', version: 2 } },
      { id: 'child-1', at: AT },
    );
    expect(run).toMatchObject({
      id: 'child-1',
      kind: 'test',
      status: 'Queued',
      test: { id: 'a', version: 4 },
      testData: { id: 'd', version: 2 },
      variableOverrides: { region: 'eu' },
      requestedBy: 'tester',
    });
    expect(run.snapshots.test).toBe(first.snapshots.tests[0]);
    expect(() =>
      buildChildRun(
        first,
        { test: { id: 'a', version: 99 }, testData: { id: 'd', version: 2 } },
        { id: 'x', at: AT },
      ),
    ).toThrow('missing a Test or Test Data version');
  });
});

describe('mirrored item transitions', () => {
  it('lets a late scheduler jump to any state the child already reached', () => {
    for (const to of ['Running', 'Paused', 'Succeeded', 'Failed', 'Cancelled'] as const)
      expect(decideSuiteItemTransition('Queued', to)).toBe('apply');
    expect(decideSuiteItemTransition('Paused', 'Running')).toBe('apply');
    expect(decideSuiteItemTransition('Cancelling', 'Succeeded')).toBe('apply');
  });

  it('still refuses to move backwards from a final state or skip dispatch', () => {
    for (const from of ['Succeeded', 'Failed', 'Cancelled', 'Skipped'] as const)
      expect(decideSuiteItemTransition(from, 'Running')).toBe('reject');
    expect(decideSuiteItemTransition('Pending', 'Running')).toBe('reject');
    expect(decideSuiteItemTransition('Pending', 'Succeeded')).toBe('reject');
    expect(decideSuiteRunTransition('Running', 'Cancelled')).toBe('apply');
  });
});

describe('Mock API setups in a Suite Run', () => {
  const mock = (id: string): MockSetupAsset => ({
    schemaVersion: 1,
    id,
    version: 1,
    name: id,
    tags: [],
    metadata: meta,
    rules: [{ path: `/${id}`, status: 200 }],
  });

  it('snapshots every setup used by the Suite or its Tests, and gives each child only its own', () => {
    const withHelpers = { ...test('a'), helpers: { mockApi: { setupIds: ['test-level'] } } };
    const plan = buildSuiteRunPlan({
      ...base,
      suite: {
        ...suite([
          { testId: 'a', dataSetId: 'd' },
          { testId: 'b', dataSetId: 'd' },
        ]),
        helpers: { mockApi: { setupIds: ['suite-level'] } },
      },
      tests: [withHelpers, test('b')],
      testData: [data('d')],
      mockSetups: [mock('suite-level'), mock('test-level'), mock('unused')],
      environment: env(),
    });
    expect(plan.suiteRun.snapshots.mockSetups?.map((setup) => setup.id)).toEqual([
      'suite-level',
      'test-level',
    ]);

    const [first, second] = plan.items;
    const childA = buildChildRun(plan.suiteRun, first!, { id: 'run-a', at: AT });
    const childB = buildChildRun(plan.suiteRun, second!, { id: 'run-b', at: AT });
    expect(childA.snapshots.mockSetups?.map((setup) => setup.id)).toEqual([
      'suite-level',
      'test-level',
    ]);
    expect(childB.snapshots.mockSetups?.map((setup) => setup.id)).toEqual(['suite-level']);
  });

  it('keeps no mockSetups when nothing asks for them, and keeps them on a rerun', () => {
    const none = buildSuiteRunPlan({
      ...base,
      suite: suite([{ testId: 'a', dataSetId: 'd' }]),
      tests: [test('a')],
      testData: [data('d')],
      environment: env(),
    });
    expect(none.suiteRun.snapshots).not.toHaveProperty('mockSetups');

    const original = buildSuiteRunPlan({
      ...base,
      suite: {
        ...suite([{ testId: 'a', dataSetId: 'd' }]),
        helpers: { mockApi: { setupIds: ['m'] } },
      },
      tests: [test('a')],
      testData: [data('d')],
      mockSetups: [mock('m')],
      environment: env(),
    });
    const again = planSuiteRerun(original.suiteRun, {
      requestedBy: 'tester',
      requestedAt: AT,
      newId,
    });
    expect(again.suiteRun.snapshots.mockSetups?.map((setup) => setup.id)).toEqual(['m']);
  });

  it('refuses a setup that is missing from the candidates', () => {
    expect(() =>
      buildSuiteRunPlan({
        ...base,
        suite: {
          ...suite([{ testId: 'a', dataSetId: 'd' }]),
          helpers: { mockApi: { setupIds: ['gone'] } },
        },
        tests: [test('a')],
        testData: [data('d')],
        environment: env(),
      }),
    ).toThrow(/Mock API setup "gone"/);
  });
});
