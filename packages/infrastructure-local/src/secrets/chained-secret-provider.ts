import type { SecretProviderKind, SecretReference } from '@test-platform/contracts';
import {
  PlatformError,
  type SecretProvider,
  type SecretReadiness,
  type SecretReferenceResolver,
  type SecretSource,
} from '@test-platform/core';

const MIN_DERIVED_LENGTH = 8;
/** Parts of a connection string that are secrets on their own and may be logged separately. */
const SECRET_PARTS = /^(sharedaccesskey|accountkey|password|pwd|sharedaccesssignature)$/i;

/** The whole value plus the secret parts of a `Key=Value;` connection string. */
export const sensitiveParts = (value: string): string[] => {
  const parts = [value];
  if (value.includes('=') && value.includes(';')) {
    for (const segment of value.split(';')) {
      const index = segment.indexOf('=');
      if (index <= 0) continue;
      const key = segment.slice(0, index).trim();
      const part = segment.slice(index + 1).trim();
      if (SECRET_PARTS.test(key) && part.length >= MIN_DERIVED_LENGTH) parts.push(part);
    }
  }
  return parts;
};

/**
 * Resolves typed secret references by the provider each reference names. There is no implicit
 * fallback: a `keyVault` reference is never answered from local plain text (or the reverse),
 * even when the named provider is unconfigured or the secret is missing.
 */
export class ChainedSecretProvider implements SecretReferenceResolver, SecretProvider {
  readonly #sources = new Map<SecretProviderKind, SecretSource>();
  readonly #resolved = new Set<string>();

  constructor(sources: Iterable<SecretSource>) {
    for (const source of sources) {
      if (this.#sources.has(source.kind))
        throw new Error(`Secret provider "${source.kind}" is registered more than once.`);
      this.#sources.set(source.kind, source);
    }
  }

  #source(reference: SecretReference): SecretSource {
    const source = this.#sources.get(reference.provider);
    if (!source) {
      throw new PlatformError(
        'AUTH_SECRET_UNAVAILABLE',
        `Secret provider "${reference.provider}" is not configured.`,
      );
    }
    return source;
  }

  async resolve(reference: SecretReference): Promise<string> {
    const source = this.#source(reference);
    const value = await source.getSecret(reference.name);
    if (value === undefined) {
      throw new PlatformError(
        'AUTH_SECRET_UNAVAILABLE',
        `Secret "${reference.name}" was not found in provider "${reference.provider}".`,
      );
    }
    for (const part of sensitiveParts(value)) this.#resolved.add(part);
    return value;
  }

  async checkReadiness(reference: SecretReference): Promise<SecretReadiness> {
    const source = this.#sources.get(reference.provider);
    return source ? source.readiness(reference.name) : 'unconfigured';
  }

  /** Phase 1 name-only lookup: a bare name always means `localPlainText`. */
  async getSecret(name: string): Promise<string | undefined> {
    const local = this.#sources.get('localPlainText');
    const value = await local?.getSecret(name);
    if (value !== undefined) for (const part of sensitiveParts(value)) this.#resolved.add(part);
    return value;
  }

  sensitiveValues(): string[] {
    const values = new Set(this.#resolved);
    for (const source of this.#sources.values()) {
      for (const value of source.sensitiveValues())
        for (const part of sensitiveParts(value)) values.add(part);
    }
    return [...values];
  }
}
