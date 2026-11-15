import type { JsonValue, TestDefinition, ValidationIssue } from '@test-platform/contracts';
import { PlatformError } from '../errors.js';
import { ExpressionError, parseTemplate, type Reference } from './parse.js';
import { GLOBAL_NAMES } from './globals.js';
import { resolveValue, type ExpressionContext } from './resolve.js';

export type LocatedReference = { location: string; reference: Reference };

/** Collects references from every string in a JSON value; syntax errors are returned, not thrown. */
export const collectReferences = (
  value: JsonValue,
  location = '',
): { references: LocatedReference[]; issues: ValidationIssue[] } => {
  const references: LocatedReference[] = [];
  const issues: ValidationIssue[] = [];

  const visit = (node: JsonValue, path: string): void => {
    if (typeof node === 'string') {
      try {
        for (const segment of parseTemplate(node).segments) {
          if (segment.kind === 'expression')
            references.push({ location: path, reference: segment.reference });
        }
      } catch (error) {
        if (!(error instanceof ExpressionError)) throw error;
        issues.push({ path, message: error.message, keyword: 'expression' });
      }
    } else if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}/${index}`));
    } else if (typeof node === 'object' && node !== null) {
      for (const [key, item] of Object.entries(node)) visit(item, `${path}/${key}`);
    }
  };
  visit(value, location);
  return { references, issues };
};

const variableDependencies = (declared: Record<string, JsonValue>): Map<string, Set<string>> => {
  const graph = new Map<string, Set<string>>();
  for (const [name, value] of Object.entries(declared)) {
    const dependencies = new Set<string>();
    for (const { reference } of collectReferences(value).references) {
      if (reference.root === 'variables' && reference.path[0] !== undefined)
        dependencies.add(reference.path[0]);
    }
    graph.set(name, dependencies);
  }
  return graph;
};

/** Returns variable names in dependency order, or throws describing the first cycle. */
const orderVariables = (graph: Map<string, Set<string>>): string[] => {
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (name: string, trail: string[]): void => {
    const current = state.get(name);
    if (current === 'done') return;
    if (current === 'visiting') {
      const cycle = [...trail.slice(trail.indexOf(name)), name].join(' -> ');
      throw new ExpressionError(`Circular variable reference: ${cycle}.`);
    }
    state.set(name, 'visiting');
    for (const dependency of graph.get(name) ?? []) {
      if (graph.has(dependency)) visit(dependency, [...trail, name]);
    }
    state.set(name, 'done');
    order.push(name);
  };
  for (const name of graph.keys()) visit(name, []);
  return order;
};

/**
 * Resolves Test variables (plus non-secret overrides) before node execution.
 * Variables may depend on each other in any declared order; cycles are rejected.
 */
export const resolveVariables = (
  declared: Record<string, JsonValue>,
  base: Pick<ExpressionContext, 'testData' | 'environment' | 'global'>,
  overrides: Record<string, JsonValue> = {},
): Record<string, JsonValue> => {
  for (const name of Object.keys(overrides)) {
    if (!Object.hasOwn(declared, name)) {
      throw new PlatformError(
        'VALIDATION_REFERENCE',
        `Override "${name}" does not match a declared variable.`,
      );
    }
  }
  const effective = { ...declared, ...overrides };
  const order = orderVariables(variableDependencies(effective));

  const resolved: Record<string, JsonValue> = {};
  const context: ExpressionContext = { ...base, variables: resolved, steps: {} };
  for (const name of order) resolved[name] = resolveValue(effective[name] as JsonValue, context);
  return resolved;
};

export type ExpressionValidationOptions = {
  /** Node ids in execution order; steps may only reference earlier entries. */
  order: string[];
  /** When provided, `environment.<key>` references are checked against these keys. */
  environmentKeys?: Iterable<string>;
};

/** Static checks of every expression in a Test: syntax, allowed roots, and preceding-step rules. */
export const validateExpressions = (
  test: Pick<TestDefinition, 'variables' | 'nodes'>,
  options: ExpressionValidationOptions,
): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  const declared = new Set(Object.keys(test.variables));
  const environmentKeys = options.environmentKeys ? new Set(options.environmentKeys) : undefined;
  const position = new Map(options.order.map((id, index) => [id, index]));

  const check = (references: LocatedReference[], nodeIndex: number | undefined): void => {
    for (const { location: where, reference } of references) {
      const problem = (message: string): void => {
        issues.push({ path: where, message, keyword: 'expression' });
      };
      if (reference.root === 'variables') {
        const name = reference.path[0];
        if (name === undefined) problem('Reference to "variables" must name a variable.');
        else if (!declared.has(name)) problem(`Variable "${name}" is not declared.`);
      } else if (reference.root === 'environment') {
        const key = reference.path[0];
        if (environmentKeys && key !== undefined && !environmentKeys.has(key)) {
          problem(`Environment value "${key}" is not available.`);
        }
      } else if (reference.root === 'global') {
        const name = reference.path[0];
        if (name === undefined || reference.path.length !== 1 || !GLOBAL_NAMES.includes(name))
          problem(
            `"${reference.raw}" is not a global variable (available: ${GLOBAL_NAMES.join(', ')}).`,
          );
      } else if (reference.root === 'steps') {
        const nodeId = reference.path[0] as string;
        if (nodeIndex === undefined) problem('Variables cannot reference step outputs.');
        else if (!position.has(nodeId)) problem(`Step "${nodeId}" does not exist.`);
        else if ((position.get(nodeId) as number) >= nodeIndex)
          problem(`Step "${nodeId}" does not precede this Step.`);
      }
    }
  };

  for (const [name, value] of Object.entries(test.variables)) {
    const { references, issues: syntax } = collectReferences(value, `/variables/${name}`);
    issues.push(...syntax);
    check(references, undefined);
  }
  try {
    orderVariables(variableDependencies(test.variables));
  } catch (error) {
    if (!(error instanceof ExpressionError)) throw error;
    issues.push({ path: '/variables', message: error.message, keyword: 'expression' });
  }

  test.nodes.forEach((node, index) => {
    const base = `/nodes/${index}/parameters`;
    const { references, issues: syntax } = collectReferences(node.parameters, base);
    issues.push(...syntax);
    check(references, position.get(node.id) ?? Number.MAX_SAFE_INTEGER);
  });
  return issues;
};
