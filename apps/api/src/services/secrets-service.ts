import {
  type KeyVaultReferenceView,
  type LocalSecretView,
  type SecretUse,
  type SecretsOverview,
} from '@test-platform/contracts';
import {
  PlatformError,
  collectSecretReferences,
  type AuditLog,
  type Clock,
  type SecretReferenceResolver,
} from '@test-platform/core';
import type { LocalSecretsStore } from '@test-platform/infrastructure-local';
import type { EnvironmentService } from './environment-service.js';

type Deps = {
  store: LocalSecretsStore;
  resolver: Pick<SecretReferenceResolver, 'checkReadiness'>;
  environments: EnvironmentService;
  audit: AuditLog;
  clock: Clock;
  /** Shown instead of an absolute path. */
  fileLabel: string;
};

const keyOf = (name: string): string => name.toLowerCase().replace(/-/g, '_');

/**
 * Overview and edits of secrets. Values are write-only: nothing here, or in the API built on it,
 * can read a stored value. Audit entries record the secret's name, never its value.
 */
export class SecretsService {
  readonly #deps: Deps;

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  async overview(): Promise<SecretsOverview> {
    let references: {
      target: string;
      environmentId: string;
      reference: ReturnType<typeof collectSecretReferences>[number]['reference'];
    }[] = [];
    let environmentsAvailable = true;
    try {
      for (const environment of await this.#deps.environments.listConfigs()) {
        for (const { target, reference } of collectSecretReferences(environment))
          references.push({ target, environmentId: environment.id, reference });
      }
    } catch {
      environmentsAvailable = false;
      references = [];
    }

    const entries = await this.#deps.store.describe();
    const local = new Map<string, LocalSecretView>();
    for (const entry of entries) {
      local.set(keyOf(entry.name), {
        name: entry.name,
        source: entry.inEnvironment ? 'environment' : 'file',
        inFile: entry.inFile,
        shadowedByEnvironment: entry.inFile && entry.inEnvironment,
        usedBy: [],
      });
    }
    const vault = new Map<string, KeyVaultReferenceView>();
    for (const { target, environmentId, reference } of references) {
      const use: SecretUse = { environmentId, target };
      if (reference.provider === 'localPlainText') {
        let view = local.get(keyOf(reference.name));
        if (!view) {
          // Referenced but not set anywhere: listed so it can be filled in.
          view = {
            name: reference.name,
            source: 'missing',
            inFile: false,
            shadowedByEnvironment: false,
            usedBy: [],
          };
          local.set(keyOf(reference.name), view);
        }
        // An environment-only secret is known by its normalised name; show the spelling the
        // Environment uses instead.
        if (!view.inFile) view.name = reference.name;
        view.usedBy.push(use);
        if (reference.usage && !view.usage) view.usage = reference.usage;
      } else {
        let view = vault.get(reference.name);
        if (!view) {
          view = {
            name: reference.name,
            usedBy: [],
            status: await this.#deps.resolver
              .checkReadiness(reference)
              .then((status) => (status === 'configured' ? 'configured' : 'unconfigured')),
          };
          vault.set(reference.name, view);
        }
        view.usedBy.push(use);
        if (reference.usage && !view.usage) view.usage = reference.usage;
      }
    }

    const probe = await this.#deps.resolver.checkReadiness({
      type: 'secretReference',
      provider: 'keyVault',
      name: 'probe',
    });
    return {
      local: [...local.values()].sort((a, b) => a.name.localeCompare(b.name)),
      keyVault: [...vault.values()].sort((a, b) => a.name.localeCompare(b.name)),
      keyVaultConfigured: probe === 'configured',
      secretsFile: this.#deps.fileLabel,
      environmentsAvailable,
    };
  }

  async setLocal(
    name: string,
    value: string,
    actor: string,
  ): Promise<{ shadowedByEnvironment: boolean }> {
    await this.#deps.store.set(name, value);
    await this.#audit(actor, 'secret.set', name);
    return { shadowedByEnvironment: this.#deps.store.hasInEnvironment(name) };
  }

  async removeLocal(name: string, actor: string): Promise<void> {
    if (!(await this.#deps.store.remove(name)))
      throw new PlatformError(
        'VALIDATION_NOT_FOUND',
        `Secret "${name}" is not in the secrets file.`,
      );
    await this.#audit(actor, 'secret.delete', name);
  }

  async #audit(actor: string, action: string, name: string): Promise<void> {
    await this.#deps.audit.append({
      actor,
      action,
      entityType: 'local-secret',
      entityId: name,
      at: this.#deps.clock.now().toISOString(),
      metadata: {},
    });
  }
}
