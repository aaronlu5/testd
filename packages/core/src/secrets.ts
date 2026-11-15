import type {
  EnvironmentConfig,
  EnvironmentTarget,
  SecretProviderKind,
  SecretReference,
} from '@test-platform/contracts';

/** Result of checking that a reference can be satisfied, without reading or returning the value. */
export type SecretReadiness = 'available' | 'missing' | 'configured' | 'unconfigured';

/**
 * Resolves typed secret references. Providers are chosen only by the reference's `provider`;
 * there is no fallback from one provider to another.
 */
export interface SecretReferenceResolver {
  /** Returns the value; throws a PlatformError (never containing the value) when unavailable. */
  resolve(reference: SecretReference): Promise<string>;
  /** Readiness only: never fetches a remote secret and never returns a value. */
  checkReadiness(reference: SecretReference): Promise<SecretReadiness>;
  /** Values known to be sensitive (resolved or ambient), for redaction. */
  sensitiveValues(): Iterable<string>;
}

/** A single provider behind the chained resolver. */
export interface SecretSource {
  readonly kind: SecretProviderKind;
  getSecret(name: string): Promise<string | undefined>;
  readiness(name: string): Promise<SecretReadiness>;
  sensitiveValues(): Iterable<string>;
}

/** The Phase 1 `secretRef` string is a `localPlainText` name; expose it as a typed reference. */
export const legacySecretReference = (name: string): SecretReference => ({
  type: 'secretReference',
  provider: 'localPlainText',
  name,
});

export const targetSecretReferences = (target: EnvironmentTarget): SecretReference[] => {
  switch (target.kind) {
    case 'http':
      if (target.authentication) return [target.authentication];
      return target.secretRef ? [legacySecretReference(target.secretRef)] : [];
    case 'azureServiceBus':
      return target.credential ? [target.credential] : [];
    case 'azureBlob':
    case 'sqlServer':
      return target.credential ? [target.credential] : [];
  }
};

/** Every secret reference an Environment makes, for readiness checks and redaction setup. */
export const collectSecretReferences = (
  environment: Pick<EnvironmentConfig, 'targets'>,
): { target: string; reference: SecretReference }[] =>
  Object.entries(environment.targets).flatMap(([target, config]) =>
    targetSecretReferences(config).map((reference) => ({ target, reference })),
  );
