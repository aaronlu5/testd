import { Ajv, type ErrorObject, type Options } from 'ajv';
import addFormatsModule from 'ajv-formats';
import type {
  AssetType,
  MockSetupAsset,
  SuiteAsset,
  TestDataAsset,
  TestDefinition,
} from './assets.js';
import type { EnvironmentConfig, EnvironmentsFile } from './environment.js';
import type { ProblemDetails, ValidationIssue } from './errors.js';
import type { RunEvent } from './events.js';
import type { JsonSchema } from './json.js';
import type { Artifact, Run, RunPause, StepRun } from './runs.js';
import type { SuiteRun, SuiteRunItem } from './suite-runs.js';
import type { SuiteRunUpdatedEvent } from './events.js';
import { allSchemas, schemaId } from './schemas.js';
import {
  breakpointConfigSchema,
  type BreakpointParameters,
  type StepTypeMetadata,
} from './steps.js';

type FormatsPlugin = typeof addFormatsModule.default;
// ajv-formats is CommonJS; under Node ESM the default import is the plugin function itself.
const addFormats = addFormatsModule as unknown as FormatsPlugin;

export type ValidationResult<T> =
  { valid: true; value: T; issues: [] } | { valid: false; issues: ValidationIssue[] };

export type Validator<T> = (value: unknown) => ValidationResult<T>;

const AJV_OPTIONS: Options = {
  allErrors: true,
  strict: true,
  allowUnionTypes: true,
  discriminator: true,
};

const createAjv = (): Ajv => {
  const ajv = new Ajv(AJV_OPTIONS);
  addFormats(ajv);
  return ajv;
};

const toIssues = (errors: ErrorObject[] | null | undefined): ValidationIssue[] =>
  (errors ?? []).map((error) => {
    const params = error.params as { missingProperty?: string; additionalProperty?: string };
    const extra = params.missingProperty ?? params.additionalProperty;
    return {
      path: extra ? `${error.instancePath}/${extra}` : error.instancePath,
      message: error.message ?? 'is invalid',
      keyword: error.keyword,
    };
  });

const toValidator =
  <T>(
    validate: (value: unknown) => boolean,
    errorsOf: () => ErrorObject[] | null | undefined,
  ): Validator<T> =>
  (value) =>
    validate(value)
      ? { valid: true, value: value as T, issues: [] }
      : { valid: false, issues: toIssues(errorsOf()) };

/**
 * Compiles a standalone schema (for example a Step configSchema) in an isolated Ajv instance.
 * Schemas must not declare `$id`.
 */
export const createSchemaValidator = <T = unknown>(schema: JsonSchema): Validator<T> => {
  const validate = createAjv().compile(schema);
  return toValidator<T>(
    (value) => validate(value) as boolean,
    () => validate.errors,
  );
};

const platformAjv = createAjv();
for (const schema of allSchemas) platformAjv.addSchema(schema);

const platformValidator = <T>(name: string): Validator<T> => {
  const validate = platformAjv.getSchema(schemaId(name));
  if (!validate) throw new Error(`Schema "${name}" is not registered.`);
  return toValidator<T>(
    (value) => validate(value) as boolean,
    () => validate.errors,
  );
};

export const validateTest = platformValidator<TestDefinition>('test');
export const validateTestData = platformValidator<TestDataAsset>('test-data');
export const validateSuite = platformValidator<SuiteAsset>('suite');
export const validateMockSetup = platformValidator<MockSetupAsset>('mock-setup');
export const validateEnvironment = platformValidator<EnvironmentConfig>('environment');
export const validateEnvironmentsFile = platformValidator<EnvironmentsFile>('environments-file');
export const validateRun = platformValidator<Run>('run');
export const validateStepRun = platformValidator<StepRun>('step-run');
export const validateArtifact = platformValidator<Artifact>('artifact');
export const validateProblemDetails = platformValidator<ProblemDetails>('problem-details');
export const validateStepTypeMetadata = platformValidator<StepTypeMetadata>('step-type-metadata');
export const validateRunEvent = platformValidator<RunEvent>('run-event');
export const validateRunPause = platformValidator<RunPause>('run-pause');
export const validateSuiteRun = platformValidator<SuiteRun>('suite-run');
export const validateSuiteRunItem = platformValidator<SuiteRunItem>('suite-run-item');
export const validateSuiteRunEvent = platformValidator<SuiteRunUpdatedEvent>('suite-run-event');
export const validateBreakpointParameters =
  createSchemaValidator<BreakpointParameters>(breakpointConfigSchema);

const assetValidators = {
  test: validateTest,
  'test-data': validateTestData,
  suite: validateSuite,
  'mock-setup': validateMockSetup,
} as const;

export const validateAsset = (
  type: AssetType,
  value: unknown,
): ValidationResult<TestDefinition | TestDataAsset | SuiteAsset | MockSetupAsset> =>
  (
    assetValidators[type] as Validator<TestDefinition | TestDataAsset | SuiteAsset | MockSetupAsset>
  )(value);
