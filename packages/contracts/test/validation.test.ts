import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createSchemaValidator,
  validateArtifact,
  validateEnvironmentsFile,
  validateProblemDetails,
  validateRun,
  validateRunEvent,
  validateRunPause,
  validateSuiteRun,
  validateSuiteRunEvent,
  validateSuiteRunItem,
  validateStepRun,
  validateStepTypeMetadata,
  validateSuite,
  validateTest,
  validateTestData,
  type Validator,
} from '../src/index.js';

const fixturesRoot = join(import.meta.dirname, '..', 'fixtures');
const load = (kind: 'valid' | 'invalid', file: string): unknown =>
  JSON.parse(readFileSync(join(fixturesRoot, kind, file), 'utf8'));

const validators: Record<string, Validator<unknown>> = {
  test: validateTest,
  'test-data': validateTestData,
  suite: validateSuite,
  environments: validateEnvironmentsFile,
  run: validateRun,
  'step-run': validateStepRun,
  artifact: validateArtifact,
  'problem-details': validateProblemDetails,
  'run-event': validateRunEvent,
  'step-type-metadata': validateStepTypeMetadata,
  'run-pause': validateRunPause,
  'suite-run': validateSuiteRun,
  'suite-run-item': validateSuiteRunItem,
  'suite-run-event': validateSuiteRunEvent,
};

const kindOf = (file: string): string => file.replace(/\.json$/, '').split('--')[0] as string;

describe('valid fixtures', () => {
  for (const file of readdirSync(join(fixturesRoot, 'valid'))) {
    it(`${file} passes validation`, () => {
      const result = validators[kindOf(file)]!(load('valid', file));
      expect(result.issues).toEqual([]);
      expect(result.valid).toBe(true);
    });
  }
});

describe('invalid fixtures', () => {
  const expectations: Record<string, { path?: string; keyword?: string }> = {
    'test--bad-schema-version.json': { path: '/schemaVersion', keyword: 'enum' },
    'test--bad-id.json': { path: '/id', keyword: 'pattern' },
    'test--zero-version.json': { path: '/version', keyword: 'minimum' },
    'test--no-nodes.json': { path: '/nodes', keyword: 'minItems' },
    'test--unknown-property.json': { path: '/surprise', keyword: 'additionalProperties' },
    'test-data--missing-data.json': { path: '/data', keyword: 'required' },
    'suite--empty-items.json': { path: '/items', keyword: 'minItems' },
    'environments--connection-string.json': { keyword: 'additionalProperties' },
    'problem-details--bad-code.json': { path: '/code', keyword: 'pattern' },
    'run-event--unknown-type.json': {},
    'test--v2-missing-editor.json': { path: '/editor', keyword: 'required' },
    'test--bad-position.json': { path: '/nodes/0/position/x', keyword: 'type' },
    'test--bad-layout-direction.json': { path: '/editor/layoutDirection', keyword: 'enum' },
    'environments--inline-secret-value.json': { keyword: 'additionalProperties' },
    'environments--unknown-secret-provider.json': {},
    'environments--local-name-is-a-uri.json': {},
    'environments--servicebus-no-namespace.json': { keyword: 'anyOf' },
    'run--bad-status.json': { path: '/status', keyword: 'enum' },
    'suite-run--bad-concurrency.json': { path: '/maxConcurrency', keyword: 'minimum' },
    'run-event--paused-missing-generation.json': {},
  };

  for (const file of readdirSync(join(fixturesRoot, 'invalid'))) {
    it(`${file} is rejected with a useful issue`, () => {
      const expected = expectations[file];
      expect(expected, `missing expectation for ${file}`).toBeDefined();

      const result = validators[kindOf(file)]!(load('invalid', file));
      expect(result.valid).toBe(false);
      if (expected?.path) expect(result.issues.map((i) => i.path)).toContain(expected.path);
      if (expected?.keyword)
        expect(result.issues.map((i) => i.keyword)).toContain(expected.keyword);
    });
  }
});

describe('createSchemaValidator', () => {
  const validate = createSchemaValidator<{ seconds: number }>({
    type: 'object',
    required: ['seconds'],
    additionalProperties: false,
    properties: { seconds: { type: 'number', minimum: 0 } },
  });

  it('accepts conforming values and returns the typed value', () => {
    const result = validate({ seconds: 2 });
    expect(result.valid && result.value.seconds).toBe(2);
  });

  it('reports every problem with a path', () => {
    const result = validate({ seconds: -1, extra: 1 });
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.path).sort()).toEqual(['/extra', '/seconds']);
  });

  it('isolates schemas between validators', () => {
    expect(() => createSchemaValidator({ $id: 'x', type: 'object' })).not.toThrow();
    expect(() => createSchemaValidator({ $id: 'x', type: 'string' })).not.toThrow();
  });
});
