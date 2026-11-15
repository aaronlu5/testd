import type { JsonValue } from './json.js';

/**
 * Detects values that look like credentials pasted into an asset. Secrets belong in a Key Vault
 * or local plain-text secret and are referenced by name; they must never be stored in a Test,
 * Test Data set, Suite, or Environment file.
 */
const SECRET_VALUE_SHAPES: readonly RegExp[] = [
  /\b(?:SharedAccessKey|AccountKey|SharedAccessSignature)\s*=\s*[^;\s"']{8,}/i,
  /\bEndpoint\s*=\s*sb:\/\/[^;\s"']+;[^"']*\b(?:SharedAccessKey|SharedAccessKeyName)\s*=/i,
  /\bDefaultEndpointsProtocol\s*=\s*https?;[^"']*\bAccountKey\s*=/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /[?&]sig=[A-Za-z0-9%+/=]{16,}/,
];

/** Parameter names that exist only to carry a secret value inline. */
const INLINE_SECRET_KEYS = new Set([
  'inlinesecret',
  'secretvalue',
  'connectionstring',
  'sharedaccesskey',
  'accountkey',
]);

const EXPRESSION = /^\s*\{\{[^}]*\}\}\s*$/;
const MAX_DEPTH = 32;

export const looksLikeSecretValue = (value: string): boolean =>
  SECRET_VALUE_SHAPES.some((shape) => shape.test(value));

export type InlineSecretFinding = {
  path: string;
  reason: 'secret-shaped-value' | 'inline-secret-key';
};

export type InlineSecretScanOptions = {
  /** Also reject parameter names that exist to carry a secret (Test node parameters only). */
  rejectSecretKeys?: boolean;
};

/**
 * Returns the JSON pointer of every inline secret in `value`. The matching text is never
 * returned, so findings are safe to put in error messages.
 */
export const findInlineSecrets = (
  value: JsonValue | undefined,
  options: InlineSecretScanOptions = {},
  basePath = '',
): InlineSecretFinding[] => {
  const findings: InlineSecretFinding[] = [];
  const visit = (node: JsonValue | undefined, path: string, depth: number): void => {
    if (depth > MAX_DEPTH || node === undefined || node === null) return;
    if (typeof node === 'string') {
      if (looksLikeSecretValue(node)) findings.push({ path, reason: 'secret-shaped-value' });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}/${index}`, depth + 1));
      return;
    }
    if (typeof node === 'object') {
      for (const [key, item] of Object.entries(node)) {
        const childPath = `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
        const normalized = key.toLowerCase().replace(/[-_\s]/g, '');
        if (
          options.rejectSecretKeys &&
          INLINE_SECRET_KEYS.has(normalized) &&
          typeof item === 'string' &&
          item !== '' &&
          !EXPRESSION.test(item)
        ) {
          findings.push({ path: childPath, reason: 'inline-secret-key' });
          continue;
        }
        visit(item, childPath, depth + 1);
      }
    }
  };
  visit(value, basePath, 0);
  return findings;
};
