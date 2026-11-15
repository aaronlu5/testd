import { PlatformError, type SecretReadiness, type SecretSource } from '@test-platform/core';

/** The slice of the Azure SDK `SecretClient` this provider uses, so tests never touch Azure. */
export interface KeyVaultSecretClient {
  getSecret(name: string, options?: { version?: string }): Promise<{ value?: string }>;
}

export type KeyVaultClientFactory = (vaultUrl: string) => Promise<KeyVaultSecretClient>;

/** Builds a real client using `DefaultAzureCredential` (`az login`, workload identity, ...). */
export const createDefaultKeyVaultClient: KeyVaultClientFactory = async (vaultUrl) => {
  // Loaded on first use so a process that never reads Key Vault does not pay for the SDK.
  const [{ DefaultAzureCredential }, { SecretClient }] = await Promise.all([
    import('@azure/identity'),
    import('@azure/keyvault-secrets'),
  ]);
  return new SecretClient(vaultUrl, new DefaultAzureCredential());
};

const VAULT_HOST_SUFFIXES = [
  '.vault.azure.net',
  '.vault.azure.cn',
  '.vault.usgovcloudapi.net',
  '.vault.microsoftazure.de',
  '.managedhsm.azure.net',
];
const SECRET_NAME = /^[0-9A-Za-z-]{1,127}$/;

export type KeyVaultLocation = { vaultUrl: string; secretName: string; version?: string };

const assertVaultUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PlatformError('VALIDATION_SECRET_REFERENCE', 'The Key Vault URL is not valid.');
  }
  const trustedHost = VAULT_HOST_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix));
  if (url.protocol !== 'https:' || url.username || url.password || !trustedHost) {
    throw new PlatformError(
      'VALIDATION_SECRET_REFERENCE',
      'The Key Vault URL must be an https Azure Key Vault endpoint.',
    );
  }
  return url.origin;
};

/** Accepts a bare secret name (uses the default vault) or a full secret URI. */
export const parseKeyVaultReference = (
  name: string,
  defaultVaultUrl: string | undefined,
): KeyVaultLocation => {
  if (!name.startsWith('https://')) {
    if (!SECRET_NAME.test(name))
      throw new PlatformError('VALIDATION_SECRET_REFERENCE', 'Key Vault secret name is not valid.');
    if (!defaultVaultUrl) {
      throw new PlatformError(
        'AUTH_SECRET_UNAVAILABLE',
        'No Key Vault URL is configured; set TEST_PLATFORM_KEY_VAULT_URL or use a full secret URI.',
      );
    }
    return { vaultUrl: assertVaultUrl(defaultVaultUrl), secretName: name };
  }
  let url: URL;
  try {
    url = new URL(name);
  } catch {
    throw new PlatformError('VALIDATION_SECRET_REFERENCE', 'Key Vault secret URI is not valid.');
  }
  const [, collection, secretName, version] = url.pathname.split('/');
  if (collection !== 'secrets' || !secretName || !SECRET_NAME.test(secretName)) {
    throw new PlatformError('VALIDATION_SECRET_REFERENCE', 'Key Vault secret URI is not valid.');
  }
  return {
    // Resolving against '/' keeps any userinfo, so embedded credentials are rejected.
    vaultUrl: assertVaultUrl(new URL('/', url).href),
    secretName,
    ...(version ? { version } : {}),
  };
};

export type AzureKeyVaultSecretProviderOptions = {
  /** Vault used for bare secret names; full secret URIs name their own vault. */
  defaultVaultUrl?: string;
  clientFactory?: KeyVaultClientFactory;
};

/** Reads secrets from Azure Key Vault. Never used unless a reference names `keyVault`. */
export class AzureKeyVaultSecretProvider implements SecretSource {
  readonly kind = 'keyVault' as const;
  readonly #defaultVaultUrl?: string;
  readonly #factory: KeyVaultClientFactory;
  readonly #clients = new Map<string, Promise<KeyVaultSecretClient>>();
  readonly #resolved = new Set<string>();

  constructor(options: AzureKeyVaultSecretProviderOptions = {}) {
    this.#defaultVaultUrl = options.defaultVaultUrl;
    this.#factory = options.clientFactory ?? createDefaultKeyVaultClient;
  }

  #client(vaultUrl: string): Promise<KeyVaultSecretClient> {
    let client = this.#clients.get(vaultUrl);
    if (!client) {
      client = this.#factory(vaultUrl);
      this.#clients.set(vaultUrl, client);
    }
    return client;
  }

  async getSecret(name: string): Promise<string | undefined> {
    const location = parseKeyVaultReference(name, this.#defaultVaultUrl);
    try {
      const client = await this.#client(location.vaultUrl);
      const secret = await client.getSecret(
        location.secretName,
        location.version ? { version: location.version } : undefined,
      );
      if (secret.value === undefined || secret.value === '') return undefined;
      this.#resolved.add(secret.value);
      return secret.value;
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      const status = (error as { statusCode?: unknown }).statusCode;
      if (status === 404) return undefined;
      // SDK messages can echo request URLs and identity details; only a status or code is kept.
      const code = (error as { code?: unknown }).code;
      const detail =
        typeof status === 'number'
          ? `Key Vault returned HTTP ${status}.`
          : typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code)
            ? `Key Vault request failed (${code}).`
            : 'Key Vault request failed.';
      throw new PlatformError('AUTH_SECRET_UNAVAILABLE', 'Could not read the Key Vault secret.', {
        detail,
        retryable: false,
      });
    }
  }

  /** Configuration only: never contacts Key Vault, so readiness checks stay cheap and safe. */
  async readiness(name: string): Promise<SecretReadiness> {
    try {
      parseKeyVaultReference(name, this.#defaultVaultUrl);
      return 'configured';
    } catch {
      return 'unconfigured';
    }
  }

  sensitiveValues(): string[] {
    return [...this.#resolved];
  }
}
