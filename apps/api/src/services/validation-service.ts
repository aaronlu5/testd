import type {
  EnvironmentConfig,
  ErrorCode,
  JsonValue,
  TestDefinition,
  ValidationIssue,
} from '@test-platform/contracts';
import { validateTest as validateTestSchema } from '@test-platform/contracts';
import {
  PlatformError,
  containsExpression,
  createTargetPolicy,
  validateTestDefinition,
} from '@test-platform/core';
import {
  checkTargetStepPolicy,
  validateStepConfig,
  type StepRegistry,
} from '@test-platform/step-sdk';

/** Parameter names that would let a Test bypass the Environment target allowlist. */
const RAW_TARGET_KEYS = new Set(['connectionstring', 'url', 'baseurl', 'accounturl', 'endpoint']);

const issue = (path: string, message: string, keyword: string): ValidationIssue => ({
  path,
  message,
  keyword,
});

const hasExpression = (value: JsonValue): boolean => {
  if (typeof value === 'string') return containsExpression(value);
  if (Array.isArray(value)) return value.some(hasExpression);
  if (typeof value === 'object' && value !== null) return Object.values(value).some(hasExpression);
  return false;
};

/** Checks logical-target usage and execution limits against the selected Environment. */
export const checkEnvironmentPolicy = (
  test: TestDefinition,
  environment: EnvironmentConfig,
): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  const limits = environment.limits ?? {};
  const policy = createTargetPolicy(environment);

  test.nodes.forEach((node, index) => {
    const base = `/nodes/${index}`;
    for (const key of Object.keys(node.parameters)) {
      if (RAW_TARGET_KEYS.has(key.toLowerCase())) {
        issues.push(
          issue(
            `${base}/parameters/${key}`,
            'Raw URLs and connection strings are not allowed; reference a configured target by name.',
            'target-policy',
          ),
        );
      }
    }

    const target = node.parameters.target;
    if (target !== undefined) {
      if (typeof target !== 'string' || containsExpression(target)) {
        issues.push(
          issue(
            `${base}/parameters/target`,
            'Target must be a literal target name.',
            'target-policy',
          ),
        );
      } else if (!Object.hasOwn(environment.targets, target)) {
        issues.push(
          issue(
            `${base}/parameters/target`,
            `Target "${target}" is not configured in environment "${environment.id}".`,
            'target-policy',
          ),
        );
      }
    }

    // Fully literal parameters can be checked against the Environment allowlists now; anything
    // built from expressions is checked by the worker when the Step runs.
    if (!hasExpression(node.parameters)) {
      for (const problem of checkTargetStepPolicy(node.type, node.parameters, policy)) {
        issues.push(issue(`${base}/parameters${problem.path}`, problem.message, 'target-policy'));
      }
    }

    const timeout = node.execution?.timeoutSeconds;
    if (
      timeout !== undefined &&
      limits.maxStepTimeoutSeconds !== undefined &&
      timeout > limits.maxStepTimeoutSeconds
    ) {
      issues.push(
        issue(
          `${base}/execution/timeoutSeconds`,
          `Exceeds the environment limit of ${limits.maxStepTimeoutSeconds} seconds.`,
          'target-policy',
        ),
      );
    }
    const attempts = node.execution?.retry?.maxAttempts;
    if (
      attempts !== undefined &&
      limits.maxRetryAttempts !== undefined &&
      attempts > limits.maxRetryAttempts
    ) {
      issues.push(
        issue(
          `${base}/execution/retry/maxAttempts`,
          `Exceeds the environment limit of ${limits.maxRetryAttempts} attempts.`,
          'target-policy',
        ),
      );
    }
  });
  return issues;
};

/** Validates each node's parameters against its Step schema, as far as expressions allow. */
export const checkStepConfigurations = (
  test: TestDefinition,
  registry: StepRegistry,
): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  test.nodes.forEach((node, index) => {
    const definition = registry.get(node.type);
    if (!definition) return;
    const base = `/nodes/${index}/parameters`;

    if (!hasExpression(node.parameters)) {
      const problems = [
        ...validateStepConfig(definition as never, node.parameters),
        ...definition.validate(node.parameters, {}),
      ];
      for (const problem of problems)
        issues.push({
          ...problem,
          path: `${base}${problem.path}`,
          keyword: problem.keyword ?? 'step-config',
        });
      return;
    }

    // Values still contain expressions, so only structural rules can be checked before the run.
    const schema = definition.configSchema as {
      required?: string[];
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(node.parameters, key))
        issues.push(issue(`${base}/${key}`, 'is required', 'required'));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(node.parameters)) {
        if (!Object.hasOwn(schema.properties ?? {}, key))
          issues.push(issue(`${base}/${key}`, 'is not a known parameter', 'additionalProperties'));
      }
    }
  });
  return issues;
};

export type TestValidationReport = { valid: boolean; issues: ValidationIssue[]; order: string[] };

const CODE_BY_KEYWORD = (keyword: string | undefined): ErrorCode => {
  if (keyword?.startsWith('FLOW_')) return 'VALIDATION_FLOW';
  if (keyword === 'expression') return 'VALIDATION_EXPRESSION';
  if (keyword === 'target-policy') return 'VALIDATION_TARGET_POLICY';
  return 'VALIDATION_SCHEMA';
};

/** Picks the most specific error code for a failed validation report. */
export const reportToError = (
  report: TestValidationReport,
  message = 'The Test is not valid.',
): PlatformError => {
  const code = CODE_BY_KEYWORD(report.issues[0]?.keyword);
  return new PlatformError(code, message, { issues: report.issues });
};

export class ValidationService {
  readonly #registry: StepRegistry;

  constructor(registry: StepRegistry) {
    this.#registry = registry;
  }

  /** Server-side schema, graph, expression, Step-config, and (when given) Environment-policy checks. */
  validateTest(candidate: unknown, environment?: EnvironmentConfig): TestValidationReport {
    const schema = validateTestSchema(candidate);
    if (!schema.valid) return { valid: false, issues: schema.issues, order: [] };

    const base = validateTestDefinition(candidate, {
      isKnownStepType: (type) => this.#registry.has(type),
      environment,
    });
    const issues = [...base.issues, ...checkStepConfigurations(schema.value, this.#registry)];
    if (environment) issues.push(...checkEnvironmentPolicy(schema.value, environment));
    return { valid: issues.length === 0, issues, order: issues.length === 0 ? base.order : [] };
  }
}
