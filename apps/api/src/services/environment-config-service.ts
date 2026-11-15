import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  validateEnvironment,
  validateEnvironmentsFile,
  type EnvironmentConfig,
  type EnvironmentConfigList,
  type JsonObject,
  type ValidationIssue,
} from '@test-platform/contracts';
import {
  PlatformError,
  validateEnvironmentTargets,
  type AuditLog,
  type Clock,
} from '@test-platform/core';
import { writeFileAtomic } from '@test-platform/infrastructure-local';
import { notFound, unavailable } from '../errors.js';
import type { EnvironmentService } from './environment-service.js';

type Deps = {
  file: string;
  environments: EnvironmentService;
  audit: AuditLog;
  clock: Clock;
};

const revisionOf = (text: string): string =>
  text === '' ? 'empty' : createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * Creates, edits and deletes Environments in `config/environments.local.json`. Everything written
 * is validated like the file is when it is loaded (schema, safe targets, and the rule that
 * STAGING and PRODUCTION use Key Vault references only). A change must name the revision it was
 * based on, so it cannot silently overwrite a hand edit or another tab's change.
 */
export class EnvironmentConfigService {
  readonly #deps: Deps;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  async #read(): Promise<{ environments: EnvironmentConfig[]; revision: string }> {
    let text = '';
    try {
      text = await readFile(this.#deps.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw unavailable('Environment configuration could not be read.');
    }
    if (text.trim() === '') return { environments: [], revision: revisionOf('') };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw unavailable(
        'The Environment file is not valid JSON. Fix it by hand before editing here.',
      );
    }
    const result = validateEnvironmentsFile(parsed);
    const environments = result.valid ? result.value.environments : [];
    const ids = environments.map((environment) => environment.id);
    const unsafe = environments.some(
      (environment) => validateEnvironmentTargets(environment).length > 0,
    );
    if (!result.valid || unsafe || new Set(ids).size !== ids.length)
      throw unavailable('The Environment file is invalid. Fix it by hand before editing here.');
    return { environments, revision: revisionOf(text) };
  }

  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async list(): Promise<EnvironmentConfigList> {
    const { environments, revision } = await this.#read();
    return { items: environments, revision };
  }

  /** Schema and safety checks; returns the validated Environment or throws with field-level issues. */
  #validate(input: unknown): EnvironmentConfig {
    const schema = validateEnvironment(input);
    if (!schema.valid) throw this.#invalid(schema.issues);
    const issues = validateEnvironmentTargets(schema.value);
    if (issues.length > 0) throw this.#invalid(issues);
    return schema.value;
  }

  #invalid(issues: ValidationIssue[]): PlatformError {
    return new PlatformError('VALIDATION_SCHEMA', 'The Environment is not valid.', { issues });
  }

  #conflict(): PlatformError {
    return new PlatformError(
      'VALIDATION_CONFLICT',
      'The Environment configuration changed since you loaded it. Reload and try again.',
    );
  }

  async #save(
    next: EnvironmentConfig[],
    action: string,
    id: string,
    actor: string,
  ): Promise<EnvironmentConfigList> {
    const text = `${JSON.stringify({ environments: next }, null, 2)}\n`;
    await writeFileAtomic(this.#deps.file, text);
    this.#deps.environments.invalidate();
    await this.#deps.audit.append({
      actor,
      action,
      entityType: 'environment',
      entityId: id,
      at: this.#deps.clock.now().toISOString(),
      metadata: {} as JsonObject,
    });
    return { items: next, revision: revisionOf(text) };
  }

  create(input: unknown, revision: string, actor: string): Promise<EnvironmentConfigList> {
    return this.#exclusive(async () => {
      const environment = this.#validate(input);
      const current = await this.#read();
      if (current.revision !== revision) throw this.#conflict();
      if (current.environments.some((existing) => existing.id === environment.id))
        throw new PlatformError(
          'VALIDATION_CONFLICT',
          `Environment "${environment.id}" already exists.`,
        );
      return this.#save(
        [...current.environments, environment],
        'environment.create',
        environment.id,
        actor,
      );
    });
  }

  update(
    id: string,
    input: unknown,
    revision: string,
    actor: string,
  ): Promise<EnvironmentConfigList> {
    return this.#exclusive(async () => {
      const environment = this.#validate(input);
      if (environment.id !== id)
        throw this.#invalid([{ path: '/id', message: 'cannot be changed', keyword: 'readOnly' }]);
      const current = await this.#read();
      if (current.revision !== revision) throw this.#conflict();
      if (!current.environments.some((existing) => existing.id === id))
        throw notFound(`Environment "${id}"`);
      return this.#save(
        current.environments.map((existing) => (existing.id === id ? environment : existing)),
        'environment.update',
        id,
        actor,
      );
    });
  }

  /** Runs already started keep their own snapshot of the Environment, so deleting is safe for them. */
  remove(id: string, revision: string, actor: string): Promise<EnvironmentConfigList> {
    return this.#exclusive(async () => {
      const current = await this.#read();
      if (current.revision !== revision) throw this.#conflict();
      if (!current.environments.some((existing) => existing.id === id))
        throw notFound(`Environment "${id}"`);
      return this.#save(
        current.environments.filter((existing) => existing.id !== id),
        'environment.delete',
        id,
        actor,
      );
    });
  }
}
