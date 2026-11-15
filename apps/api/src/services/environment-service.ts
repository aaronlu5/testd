import { readFile, stat } from 'node:fs/promises';
import {
  validateEnvironmentsFile,
  type EnvironmentConfig,
  type EnvironmentSummary,
} from '@test-platform/contracts';
import { PlatformError, validateEnvironmentTargets } from '@test-platform/core';
import { unavailable } from '../errors.js';

type Cache = { mtimeMs: number; size: number; environments: EnvironmentConfig[] };

/** Loads the non-secret Environment configuration, re-reading it when the file changes. */
export class EnvironmentService {
  readonly #file: string;
  #cache?: Cache;

  constructor(file: string) {
    this.#file = file;
  }

  async #load(): Promise<EnvironmentConfig[]> {
    let info;
    try {
      info = await stat(this.#file);
    } catch {
      throw unavailable('Environment configuration is not available.');
    }
    if (this.#cache && this.#cache.mtimeMs === info.mtimeMs && this.#cache.size === info.size) {
      return this.#cache.environments;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.#file, 'utf8'));
    } catch {
      throw unavailable('Environment configuration could not be read.');
    }
    const result = validateEnvironmentsFile(parsed);
    const environments = result.valid ? result.value.environments : [];
    const ids = environments.map((environment) => environment.id);
    // Schema-valid targets must also be safe: https hosts, no embedded credentials or SAS tokens,
    // well-formed allowlists.
    const unsafe = environments.some(
      (environment) => validateEnvironmentTargets(environment).length > 0,
    );
    if (!result.valid || unsafe || new Set(ids).size !== ids.length) {
      throw unavailable('Environment configuration is invalid.');
    }
    this.#cache = { mtimeMs: info.mtimeMs, size: info.size, environments };
    return environments;
  }

  /** Forget the cached file so the next read sees a change made through the API. */
  invalidate(): void {
    this.#cache = undefined;
  }

  async list(): Promise<EnvironmentSummary[]> {
    return (await this.#load()).map(summarizeEnvironment);
  }

  /** Full configuration (secret references, never values); for server-side use only. */
  async listConfigs(): Promise<EnvironmentConfig[]> {
    return this.#load();
  }

  async require(id: string): Promise<EnvironmentConfig> {
    const environment = (await this.#load()).find((candidate) => candidate.id === id);
    if (!environment) {
      throw new PlatformError('VALIDATION_REFERENCE', `Environment "${id}" is not configured.`);
    }
    return environment;
  }

  async check(): Promise<boolean> {
    try {
      await this.#load();
      return true;
    } catch {
      return false;
    }
  }
}

export const summarizeEnvironment = (environment: EnvironmentConfig): EnvironmentSummary => ({
  id: environment.id,
  name: environment.name,
  classification: environment.classification,
  suiteConcurrencyLimit: environment.limits?.maxSuiteConcurrency ?? 1,
  targets: Object.entries(environment.targets).map(([name, target]) => ({
    name,
    kind: target.kind,
    ...(target.kind === 'azureServiceBus'
      ? {
          serviceBus: {
            entities: [...target.allowedEntities],
            canInspect: (target.allowedOperations ?? ['send']).includes('inspect'),
          },
        }
      : {}),
  })),
});
