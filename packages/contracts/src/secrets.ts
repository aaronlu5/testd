/** Providers a secret reference may name. There is never an implicit fallback between them. */
export const SECRET_PROVIDER_KINDS = ['keyVault', 'localPlainText'] as const;
export type SecretProviderKind = (typeof SECRET_PROVIDER_KINDS)[number];

export const SECRET_USAGES = ['connectionString', 'apiKey', 'bearerToken', 'password'] as const;
export type SecretUsage = (typeof SECRET_USAGES)[number];

/** `localPlainText` names map to `TEST_PLATFORM_SECRET_<NAME>` and the optional local secrets file. */
export const LOCAL_SECRET_NAME_PATTERN = '^[A-Za-z][A-Za-z0-9_-]{0,63}$';
/** A Key Vault secret name, or the full `https://<vault>/secrets/<name>[/<version>]` URI. */
export const KEY_VAULT_SECRET_NAME_PATTERN =
  '^(?:[0-9A-Za-z-]{1,127}|https://[A-Za-z0-9.-]+/secrets/[0-9A-Za-z-]{1,127}(?:/[0-9a-f]{32})?)$';

/**
 * A pointer to a secret. It never carries the value, and the schema forbids any other property,
 * so a value cannot be embedded in Environment configuration.
 */
export type SecretReference = {
  type: 'secretReference';
  provider: SecretProviderKind;
  name: string;
  usage?: SecretUsage;
};
