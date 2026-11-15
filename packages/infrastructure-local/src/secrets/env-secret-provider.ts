import { PlatformError, type SecretProvider } from '@test-platform/core';

export const SECRET_ENV_PREFIX = 'TEST_PLATFORM_SECRET_';
const SECRET_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export type EnvSecretProviderOptions = {
  env?: Record<string, string | undefined>;
  prefix?: string;
  /** When set, only these names may be resolved. */
  declaredNames?: Iterable<string>;
};

/** Resolves `<name>` from the `TEST_PLATFORM_SECRET_<NAME>` environment variable. */
export class EnvSecretProvider implements SecretProvider {
  readonly #env: Record<string, string | undefined>;
  readonly #prefix: string;
  readonly #declared?: Set<string>;

  constructor(options: EnvSecretProviderOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#prefix = options.prefix ?? SECRET_ENV_PREFIX;
    if (options.declaredNames)
      this.#declared = new Set([...options.declaredNames].map((name) => name.toLowerCase()));
  }

  async getSecret(name: string): Promise<string | undefined> {
    if (!SECRET_NAME.test(name))
      throw new PlatformError('VALIDATION_REFERENCE', 'Secret name is not valid.');
    if (this.#declared && !this.#declared.has(name.toLowerCase())) {
      throw new PlatformError('AUTH_FORBIDDEN', `Secret "${name}" is not declared for use.`);
    }
    const value = this.#env[`${this.#prefix}${name.toUpperCase().replace(/-/g, '_')}`];
    return value === undefined || value === '' ? undefined : value;
  }

  /** Every non-empty secret in the environment, so logs can mask them even if never requested. */
  sensitiveValues(): string[] {
    return Object.entries(this.#env)
      .filter(
        ([key, value]) => key.startsWith(this.#prefix) && typeof value === 'string' && value !== '',
      )
      .map(([, value]) => value as string);
  }
}
