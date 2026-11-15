import {
  BREAKPOINT_STEP_TYPE,
  findInlineSecrets,
  validateBreakpointParameters,
  validateTest,
  type EnvironmentConfig,
  type TestDefinition,
  type ValidationIssue,
} from '@test-platform/contracts';
import { validateFlow } from './flow.js';
import { validatePositionSequence } from './sequence.js';
import { validateExpressions } from './expressions/variables.js';

export type TestValidationOptions = {
  isKnownStepType?: (type: string) => boolean;
  /** Provide to check `environment.<key>` references. */
  environment?: Pick<EnvironmentConfig, 'values'>;
};

export type TestValidationResult = { valid: boolean; issues: ValidationIssue[]; order: string[] };

/** Schema, graph, and expression validation for a Test, in that order. */
export const validateTestDefinition = (
  value: unknown,
  options: TestValidationOptions = {},
): TestValidationResult => {
  const schema = validateTest(value);
  if (!schema.valid) return { valid: false, issues: schema.issues, order: [] };

  const test: TestDefinition = schema.value;

  // Secrets are referenced by name, never stored in a Test.
  const secretIssues: ValidationIssue[] = test.nodes
    .flatMap((node, index) =>
      findInlineSecrets(node.parameters, { rejectSecretKeys: true }, `/nodes/${index}/parameters`),
    )
    .concat(findInlineSecrets(test.variables, { rejectSecretKeys: true }, '/variables'))
    .map((finding) => ({
      path: finding.path,
      message:
        'This value looks like a secret. Store it in Key Vault or the local secret store and reference it from the Environment.',
      keyword: 'VALIDATION_INLINE_SECRET',
    }));
  if (secretIssues.length > 0) return { valid: false, issues: secretIssues, order: [] };

  const breakpointIssues: ValidationIssue[] = test.nodes.flatMap((node, index) => {
    if (node.type !== BREAKPOINT_STEP_TYPE) return [];
    const checked = validateBreakpointParameters(node.parameters);
    return checked.valid
      ? []
      : checked.issues.map((issue) => ({
          ...issue,
          path: `/nodes/${index}/parameters${issue.path}`,
        }));
  });
  if (breakpointIssues.length > 0) return { valid: false, issues: breakpointIssues, order: [] };

  const positionIssues = validatePositionSequence(test);
  const flow = validateFlow(test, { isKnownStepType: options.isKnownStepType });
  const issues: ValidationIssue[] = [...positionIssues, ...flow.issues].map((issue) => ({
    path:
      issue.nodeIds.length === 1
        ? `/nodes/${test.nodes.findIndex((node) => node.id === issue.nodeIds[0])}`
        : '/edges',
    message: issue.message,
    keyword: issue.code,
  }));
  if (!flow.valid || positionIssues.length > 0) return { valid: false, issues, order: [] };

  issues.push(
    ...validateExpressions(test, {
      order: flow.order,
      environmentKeys: options.environment
        ? Object.keys(options.environment.values ?? {})
        : undefined,
    }),
  );
  return { valid: issues.length === 0, issues, order: flow.order };
};
