import { readFileSync, statSync } from 'node:fs';
import { PlatformError, type SecretReadiness, type SecretSource } from '@test-platform/core';
import { SECRET_ENV_PREFIX } from './env-secret-provider.js';

const SECRET_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** `orders-service-bus-connection` -> `ORDERS_SERVICE_BUS_CONNECTION`. */
export const normalizeSecretName = (name: string): string => name.toUpperCase().replace(/-/g, '_');

export const secretEnvVarName = (name: string, prefix = SECRET_ENV_PREFIX): string =>
  `${prefix}${normalizeSecretName(name)}`;

export type FileStat = { mode: number };

/**
 * Rejects a secrets file readable or writable by group/other where the OS exposes POSIX modes.
 * Windows reports synthetic modes, so the check is skipped there and the host volume's ACLs are
 * the control; this is documented rather than silently pretended.
 */
export const assertSecretsFilePermissions = (
  path: string,
  options: {
    platform?: NodeJS.Platform;
    stat?: (path: string) => FileStat;
  } = {},
): void => {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') return;
  const { mode } = (options.stat ?? ((p: string) => statSync(p)))(path);
  if ((mode & 0o077) !== 0) {
    throw new PlatformError(
      'AUTH_FORBIDDEN',
      'The local secrets file is accessible to other users; restrict it to the worker account (chmod 600).',
    );
  }
};

export type LocalPlainTextSecretProviderOptions = {
  env?: Record<string, string | undefined>;
  prefix?: string;
  /** Optional, Git-ignored `runtime/secrets.local.json`: a flat `{ "name": "value" }` object. */
  secretsFile?: string;
  /** Override the permission check (defaults to `assertSecretsFilePermissions`). */
  checkFilePermissions?: (path: string) => void;
  /** When set, only these names may be resolved. */
  declaredNames?: Iterable<string>;
};

/**
 * Plain-text secrets for local or self-hosted installs. Precedence for one name:
 * 1. the `TEST_PLATFORM_SECRET_<NAME>` environment variable;
 * 2. the optional secrets file.
 * Nothing here ever falls back to Key Vault, and no value appears in an error message.
 */
export class LocalPlainTextSecretProvider implements SecretSource {
  readonly kind = 'localPlainText' as const;
  readonly #env: Record<string, string | undefined>;
  readonly #prefix: string;
  #fileValues = new Map<string, string>();
  readonly #declared?: Set<string>;
  readonly #secretsFile?: string;
  readonly #checkPermissions: (path: string) => void;
  /** `mtime:size` of the file as last loaded; a different stamp triggers a reload. */
  #stamp?: string;
  /** Set when the file changed into something unreadable; lookups then fail closed. */
  #broken = false;

  constructor(options: LocalPlainTextSecretProviderOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#prefix = options.prefix ?? SECRET_ENV_PREFIX;
    if (options.declaredNames)
      this.#declared = new Set([...options.declaredNames].map((name) => name.toLowerCase()));
    this.#secretsFile = options.secretsFile;
    this.#checkPermissions = options.checkFilePermissions ?? assertSecretsFilePermissions;
    // The first load is strict: a damaged file stops start-up instead of being ignored.
    this.#refresh(true);
  }

  /**
   * Re-reads the secrets file when it changed, so secrets edited in the management page reach
   * this process without a restart. A file that became unreadable keeps the last good values for
   * log masking but makes lookups fail.
   */
  #refresh(strict = false): void {
    const path = this.#secretsFile;
    if (!path) return;
    let stamp: string | undefined;
    try {
      const info = statSync(path);
      stamp = `${info.mtimeMs}:${info.size}`;
    } catch {
      stamp = undefined;
    }
    if (stamp === this.#stamp) return;
    if (stamp === undefined) {
      this.#fileValues = new Map();
      this.#stamp = undefined;
      this.#broken = false;
      return;
    }
    try {
      this.#checkPermissions(path);
      this.#fileValues = this.#loadFile(path);
      this.#broken = false;
    } catch (error) {
      if (strict) throw error;
      this.#broken = true;
    }
    this.#stamp = stamp;
  }

  #loadFile(path: string): Map<string, string> {
    const loaded = new Map<string, string>();
    const invalid = (): PlatformError =>
      new PlatformError(
        'AUTH_SECRET_UNAVAILABLE',
        'The local secrets file must be a JSON object of secret names to string values.',
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      // The parser's message can quote file content, so it is deliberately not propagated.
      throw invalid();
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
    for (const [name, value] of Object.entries(parsed)) {
      if (!SECRET_NAME.test(name) || typeof value !== 'string') throw invalid();
      const key = normalizeSecretName(name);
      if (loaded.has(key)) {
        throw new PlatformError(
          'AUTH_SECRET_UNAVAILABLE',
          `The local secrets file defines "${name}" more than once (names are case- and dash-insensitive).`,
        );
      }
      if (value !== '') loaded.set(key, value);
    }
    return loaded;
  }

  #lookup(name: string): string | undefined {
    this.#refresh();
    if (this.#broken)
      throw new PlatformError(
        'AUTH_SECRET_UNAVAILABLE',
        'The local secrets file is not readable; fix it and try again.',
      );
    if (!SECRET_NAME.test(name))
      throw new PlatformError('VALIDATION_REFERENCE', 'Secret name is not valid.');
    if (this.#declared && !this.#declared.has(name.toLowerCase())) {
      throw new PlatformError('AUTH_FORBIDDEN', `Secret "${name}" is not declared for use.`);
    }
    const fromEnv = this.#env[secretEnvVarName(name, this.#prefix)];
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
    return this.#fileValues.get(normalizeSecretName(name));
  }

  async getSecret(name: string): Promise<string | undefined> {
    return this.#lookup(name);
  }

  async readiness(name: string): Promise<SecretReadiness> {
    return this.#lookup(name) === undefined ? 'missing' : 'available';
  }

  /** Every non-empty local secret, so logs mask them even if never requested. */
  sensitiveValues(): string[] {
    this.#refresh();
    const fromEnv = Object.entries(this.#env)
      .filter(
        ([key, value]) => key.startsWith(this.#prefix) && typeof value === 'string' && value !== '',
      )
      .map(([, value]) => value as string);
    return [...fromEnv, ...this.#fileValues.values()];
  }
}
