import type { EnvironmentConfig } from './environment.js';
import type { SecretUsage } from './secrets.js';

/**
 * Environment configuration as managed in the UI. It holds hosts, allowlists and secret
 * *references*; never a secret value. `revision` identifies the file content the list was read
 * from, and a change is refused if the file changed since (a hand edit, another browser tab).
 */
export type EnvironmentConfigList = { items: EnvironmentConfig[]; revision: string };

export type EnvironmentConfigWrite = { environment: EnvironmentConfig; revision: string };

/** Where a secret reference is used. */
export type SecretUse = { environmentId: string; target: string };

/**
 * A local plain-text secret. The value is never returned: it can be replaced or removed, not read.
 * `source` says where the value Testd uses comes from; only the secrets file can be edited here.
 */
export type LocalSecretView = {
  name: string;
  source: 'file' | 'environment' | 'missing';
  /** True when a value exists in the file (it can be replaced or removed). */
  inFile: boolean;
  /** A `TEST_PLATFORM_SECRET_<NAME>` environment variable is set; it overrides the file. */
  shadowedByEnvironment: boolean;
  usage?: SecretUsage;
  usedBy: SecretUse[];
};

/** A Key Vault reference. Only the pointer is known to Testd; the value stays in Azure. */
export type KeyVaultReferenceView = {
  name: string;
  usage?: SecretUsage;
  usedBy: SecretUse[];
  /** Whether a vault is configured to resolve this reference (nothing is fetched to find out). */
  status: 'configured' | 'unconfigured';
};

export type SecretsOverview = {
  local: LocalSecretView[];
  keyVault: KeyVaultReferenceView[];
  keyVaultConfigured: boolean;
  /** Label of the file edits are written to (not an absolute path). */
  secretsFile: string;
  /** False when the Environment file cannot be read, so usage cannot be shown. */
  environmentsAvailable: boolean;
};
