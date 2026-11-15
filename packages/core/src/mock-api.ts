import {
  compileMockPattern,
  matchesMockPattern,
  type CompiledMockPattern,
  type JsonValue,
  type MockRule,
  type MockSetupAsset,
} from '@test-platform/contracts';

/** A rule with its path compiled, remembering which setup it came from. */
export type CompiledMockRule = {
  setupId: string;
  setupName: string;
  ruleIndex: number;
  rule: MockRule;
  pattern: CompiledMockPattern;
};

export type MockResponse = {
  status: number;
  /** The JSON text to send, or undefined for an empty body. */
  body: string | undefined;
  setupId: string;
  setupName: string;
  ruleIndex: number;
  ruleName?: string;
};

/** A quantified group that is itself quantified, the usual shape of catastrophic backtracking. */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/;

/** Why a path pattern cannot be used, or undefined when it is fine. */
export const mockPathProblem = (path: string): string | undefined => {
  if (!path.startsWith('/')) return 'The path must start with "/".';
  if (NESTED_QUANTIFIER.test(path))
    return 'The pattern repeats a repeated group, which can make matching extremely slow. Simplify it.';
  try {
    compileMockPattern(path);
  } catch (error) {
    return `Not a valid regular expression: ${error instanceof Error ? error.message : 'unknown error'}.`;
  }
  return undefined;
};

export const compileMockSetups = (setups: readonly MockSetupAsset[]): CompiledMockRule[] =>
  setups.flatMap((setup) =>
    setup.rules.map((rule, ruleIndex) => ({
      setupId: setup.id,
      setupName: setup.name,
      ruleIndex,
      rule,
      pattern: compileMockPattern(rule.path),
    })),
  );

const MAX_MATCHED_PATH_LENGTH = 2048;

export const matchMockRule = (
  rules: readonly CompiledMockRule[],
  method: string,
  path: string,
  query = '',
): CompiledMockRule | undefined => {
  if (path.length > MAX_MATCHED_PATH_LENGTH) return undefined;
  const upper = method.toUpperCase();
  return rules.find(
    (compiled) =>
      (compiled.rule.method === undefined || compiled.rule.method === upper) &&
      matchesMockPattern(compiled.pattern, path, query),
  );
};

const toResponse = (compiled: CompiledMockRule): MockResponse => ({
  status: compiled.rule.status,
  body:
    compiled.rule.body === undefined ? undefined : JSON.stringify(compiled.rule.body as JsonValue),
  setupId: compiled.setupId,
  setupName: compiled.setupName,
  ruleIndex: compiled.ruleIndex,
  ...(compiled.rule.name ? { ruleName: compiled.rule.name } : {}),
});

/**
 * The Mock API setups that are live right now, one entry per active Run. A request is answered
 * by the first matching rule, looking at Runs in the order they started and at each Run's setups
 * and rules in the order they were added. Concurrent Runs therefore share one set of paths.
 */
export class MockApiRegistry {
  readonly #sessions = new Map<string, CompiledMockRule[]>();

  /** Starts serving a Run's setups. Replaces what the Run registered before. */
  register(runId: string, setups: readonly MockSetupAsset[]): void {
    this.#sessions.delete(runId);
    if (setups.length > 0) this.#sessions.set(runId, compileMockSetups(setups));
  }

  unregister(runId: string): void {
    this.#sessions.delete(runId);
  }

  get activeRuns(): string[] {
    return [...this.#sessions.keys()];
  }

  match(method: string, path: string, query = ''): MockResponse | undefined {
    for (const rules of this.#sessions.values()) {
      const found = matchMockRule(rules, method, path, query);
      if (found) return toResponse(found);
    }
    return undefined;
  }
}
