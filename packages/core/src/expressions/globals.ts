import { createHash } from 'node:crypto';
import type { JsonValue, Run } from '@test-platform/contracts';
import { ExpressionError, parseTemplate } from './parse.js';
import { resolveValue, type ExpressionContext } from './resolve.js';

export type GlobalValue = string | number;

export type GlobalVariableInfo = {
  name: string;
  scope: 'run' | 'test' | 'environment';
  type: 'text' | 'number';
  description: string;
  example: string;
};

/** Every global variable: the source of truth for validation and the References page. */
export const GLOBAL_VARIABLES: readonly GlobalVariableInfo[] = [
  {
    name: 'runId',
    scope: 'run',
    type: 'text',
    description: 'The unique id of this Run. A new Run, including a rerun, always gets a new one.',
    example: '2752a210-2d84-4b84-ac82-761b9e52a85b',
  },
  {
    name: 'runNumber',
    scope: 'run',
    type: 'number',
    description:
      'Counts the Runs of this Test: 1 for its first Run, then 2, 3 and so on. It is never reused.',
    example: '42',
  },
  {
    name: 'runSeed',
    scope: 'run',
    type: 'text',
    description:
      'A short random-looking value that is fixed for the Run and different in every Run. Compact enough for names and e-mail addresses.',
    example: '9f3a1c7e',
  },
  {
    name: 'runTimestamp',
    scope: 'run',
    type: 'number',
    description: 'When the Run was requested, in milliseconds since 1 January 1970 (UTC).',
    example: '1792491330000',
  },
  {
    name: 'runStartedAt',
    scope: 'run',
    type: 'text',
    description: 'When the Run was requested, as yyyyMMddTHHmmssZ (UTC).',
    example: '20261020T101530Z',
  },
  {
    name: 'runDate',
    scope: 'run',
    type: 'text',
    description: 'The date the Run was requested, as yyyyMMdd (UTC).',
    example: '20261020',
  },
  {
    name: 'testId',
    scope: 'test',
    type: 'text',
    description:
      'A short id that belongs to the Test. It is created with the Test and never changes, so data that links to a Test can rely on it.',
    example: 't-4f9ac2e81b',
  },
  {
    name: 'testVersion',
    scope: 'test',
    type: 'number',
    description: 'The saved version of the Test that is running.',
    example: '7',
  },
  {
    name: 'environmentId',
    scope: 'environment',
    type: 'text',
    description: 'The id of the Environment the Run uses.',
    example: 'orders-test',
  },
  {
    name: 'environmentClassification',
    scope: 'environment',
    type: 'text',
    description: 'The classification of the Environment: LOCAL, TEST, STAGING or PRODUCTION.',
    example: 'TEST',
  },
];

export const GLOBAL_NAMES: readonly string[] = GLOBAL_VARIABLES.map((variable) => variable.name);

/** Global values hold only letters, digits and hyphens so they are safe in names, keys and URLs. */
export const GLOBAL_VALUE_PATTERN = /^[A-Za-z0-9-]+$/;

export type GlobalSource = {
  runId: string;
  /** Per-Test Run counter; absent for Runs that have no Test (Suite Runs). */
  runNumber?: number;
  requestedAt: string;
  testId?: string;
  testVersion?: number;
  environmentId: string;
  environmentClassification: string;
};

const digest = (text: string, length: number): string =>
  createHash('sha256').update(text).digest('hex').slice(0, length);

const pad = (value: number, length = 2): string => String(value).padStart(length, '0');

/**
 * The global variables of one Run. Everything is derived from values stored with the Run, so
 * the same Run always sees the same values (a retried Step builds the same names) and a new Run
 * or rerun sees new ones.
 */
export const computeGlobals = (source: GlobalSource): Record<string, GlobalValue> => {
  const at = new Date(source.requestedAt);
  const date = `${pad(at.getUTCFullYear(), 4)}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}`;
  const time = `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;
  const globals: Record<string, GlobalValue> = {
    runId: source.runId,
    runSeed: digest(`run:${source.runId}`, 8),
    runTimestamp: at.getTime(),
    runStartedAt: `${date}T${time}Z`,
    runDate: date,
    environmentId: source.environmentId,
    environmentClassification: source.environmentClassification,
  };
  if (source.runNumber !== undefined) globals.runNumber = source.runNumber;
  if (source.testId !== undefined) globals.testId = `t-${digest(`test:${source.testId}`, 10)}`;
  if (source.testVersion !== undefined) globals.testVersion = source.testVersion;
  return globals;
};

/** The globals of a stored Run (its Test, Environment snapshot and counter). */
export const globalsOfRun = (run: Run): Record<string, GlobalValue> =>
  computeGlobals({
    runId: run.id,
    runNumber: run.runNumber,
    requestedAt: run.requestedAt,
    testId: run.test?.id,
    testVersion: run.test?.version,
    environmentId: run.environmentId,
    environmentClassification: run.snapshots.environment.classification,
  });

/** Problems with `global.<name>` references in a string; empty when it is fine. */
export const globalReferenceProblems = (text: string): string[] => {
  const problems: string[] = [];
  let parsed;
  try {
    parsed = parseTemplate(text);
  } catch (error) {
    if (error instanceof ExpressionError) return [error.message];
    throw error;
  }
  for (const segment of parsed.segments) {
    if (segment.kind !== 'expression') continue;
    const { root, path } = segment.reference;
    if (root !== 'global') {
      problems.push(
        `Test Data can only use global variables ({{ global.runId }} and so on), not "${root}".`,
      );
    } else if (path.length !== 1 || !GLOBAL_NAMES.includes(path[0] as string)) {
      problems.push(
        `"${segment.reference.raw}" is not a global variable (available: ${GLOBAL_NAMES.join(', ')}).`,
      );
    }
  }
  return problems;
};

/** Resolves `{{ global.* }}` in Test Data. Other references are not available there. */
export const resolveTestData = (
  data: JsonValue,
  globals: Record<string, GlobalValue>,
): JsonValue => {
  const context: ExpressionContext = {
    testData: {},
    variables: {},
    environment: {},
    steps: {},
    global: globals,
  };
  return resolveValue(data, context);
};
