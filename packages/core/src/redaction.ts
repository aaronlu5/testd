import type { JsonPath } from '@test-platform/contracts';

export const REDACTED = '***REDACTED***';

const SENSITIVE_KEY =
  /(password|passwd|secret|apikey|token|authorization|cookie|connectionstring|subscriptionkey)$/;
const MIN_SECRET_LENGTH = 4;
const MAX_DEPTH = 32;

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[-_\s]/g, '');

export const isSensitiveKey = (key: string): boolean => SENSITIVE_KEY.test(normalizeKey(key));

export type RedactionOptions = {
  /** Paths such as `headers.Authorization` or `items.*.token` (case-insensitive, `*` matches one segment). */
  sensitivePaths?: readonly JsonPath[];
  /** Mask values under well-known sensitive key names (default true). */
  maskSensitiveKeys?: boolean;
  /** Exact secret values to remove from any string (values shorter than 4 characters are ignored). */
  secretValues?: Iterable<string>;
  /** Also mask credential-shaped text such as `SharedAccessKey=...` (default true). */
  maskPatterns?: boolean;
};

const toSegments = (path: JsonPath): string[] =>
  path
    .replace(/^\$\.?/, '')
    .split('.')
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());

const matchesPath = (patterns: string[][], path: string[]): boolean =>
  patterns.some(
    (pattern) =>
      pattern.length === path.length &&
      pattern.every((segment, index) => segment === '*' || segment === path[index]?.toLowerCase()),
  );

const sortedSecrets = (values: Iterable<string> | undefined): string[] =>
  [...(values ?? [])]
    .filter((value) => value.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);

/**
 * Shapes that are credentials wherever they appear, even when the exact value was never
 * registered: connection-string keys, SAS signatures, bearer tokens, and PEM private keys.
 */
const SECRET_SHAPES: readonly { pattern: RegExp; replacement: string }[] = [
  {
    pattern: /\b(SharedAccessKey|AccountKey|Password|Pwd)(\s*=\s*)[^;\s"'&]+/gi,
    replacement: `$1$2${REDACTED}`,
  },
  { pattern: /\b(SharedAccessSignature)(\s+)[^\s"']+/gi, replacement: `$1$2${REDACTED}` },
  { pattern: /([?&;]sig=)[^&;\s"']+/gi, replacement: `$1${REDACTED}` },
  { pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, replacement: `$1${REDACTED}` },
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    replacement: REDACTED,
  },
];

const maskShapes = (text: string): string => {
  let result = text;
  for (const { pattern, replacement } of SECRET_SHAPES)
    result = result.replace(pattern, replacement);
  return result;
};

const maskText = (text: string, secrets: string[], maskPatterns = true): string => {
  let result = text;
  for (const secret of secrets) result = result.split(secret).join(REDACTED);
  return maskPatterns ? maskShapes(result) : result;
};

export const redactText = (text: string, secretValues?: Iterable<string>): string =>
  maskText(text, sortedSecrets(secretValues));

/** Returns a masked deep copy; the input is never mutated. */
export const redactValue = (value: unknown, options: RedactionOptions = {}): unknown => {
  const patterns = (options.sensitivePaths ?? []).map(toSegments);
  const maskKeys = options.maskSensitiveKeys ?? true;
  const maskPatterns = options.maskPatterns ?? true;
  const secrets = sortedSecrets(options.secretValues);
  const ancestors = new WeakSet<object>();

  const visit = (node: unknown, path: string[], depth: number): unknown => {
    if (matchesPath(patterns, path)) return REDACTED;
    if (typeof node === 'string') return maskText(node, secrets, maskPatterns);
    if (node === null || typeof node !== 'object') {
      return typeof node === 'function' || typeof node === 'symbol' ? undefined : node;
    }
    if (depth >= MAX_DEPTH) return '[Truncated]';
    if (ancestors.has(node)) return '[Circular]';
    if (node instanceof Date) return node.toISOString();
    if (node instanceof Error)
      return { name: node.name, message: maskText(node.message, secrets, maskPatterns) };

    ancestors.add(node);
    try {
      if (Array.isArray(node))
        return node.map((item, index) => visit(item, [...path, String(index)], depth + 1));
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node)) {
        const childPath = [...path, key];
        const masked =
          maskKeys && isSensitiveKey(key) && item !== null && item !== undefined
            ? REDACTED
            : visit(item, childPath, depth + 1);
        Object.defineProperty(result, key, {
          value: masked,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return result;
    } finally {
      ancestors.delete(node);
    }
  };
  return visit(value, [], 0);
};

export type Redactor = {
  redact: (value: unknown, sensitivePaths?: readonly JsonPath[]) => unknown;
  redactText: (text: string) => string;
};

/** Binds a live secret-value source so values registered later are still masked. */
export const createRedactor = (source: {
  secretValues: () => Iterable<string>;
  sensitivePaths?: readonly JsonPath[];
}): Redactor => ({
  redact: (value, sensitivePaths) =>
    redactValue(value, {
      sensitivePaths: [...(source.sensitivePaths ?? []), ...(sensitivePaths ?? [])],
      secretValues: source.secretValues(),
    }),
  redactText: (text) => redactText(text, source.secretValues()),
});
