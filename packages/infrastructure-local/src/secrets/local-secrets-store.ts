import { readFile } from 'node:fs/promises';
import { PlatformError } from '@test-platform/core';
import { writeFileAtomic } from '../fs/atomic.js';
import { SECRET_ENV_PREFIX } from './env-secret-provider.js';
import { normalizeSecretName, secretEnvVarName } from './local-plain-text-provider.js';

export const LOCAL_SECRET_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** Generous for a connection string or certificate-sized token, small enough to stay sane. */
export const MAX_LOCAL_SECRET_BYTES = 16 * 1024;

/** One local secret as the management UI sees it. The value is never part of this. */
export type LocalSecretEntry = {
  name: string;
  /** Stored in the local secrets file (this is the only place the UI can change). */
  inFile: boolean;
  /** Also (or only) supplied by a `TEST_PLATFORM_SECRET_<NAME>` environment variable, which wins. */
  inEnvironment: boolean;
};

export type LocalSecretsStoreOptions = {
  /** The Git-ignored `runtime/secrets.local.json`. */
  file: string;
  env?: Record<string, string | undefined>;
  prefix?: string;
};

const invalidFile = (): PlatformError =>
  new PlatformError(
    'AUTH_SECRET_UNAVAILABLE',
    'The local secrets file must be a JSON object of secret names to string values. Fix or remove it before editing secrets here.',
  );

/**
 * Read-modify-write access to the local plain-text secrets file, for the management API. Values are
 * only ever written, never listed or returned. The file is replaced atomically and created
 * readable by its owner only (the provider refuses a group- or world-readable file on POSIX).
 * Names are case- and dash-insensitive like the provider's, so setting `Orders-Key` replaces an
 * existing `orders_key`.
 */
export class LocalSecretsStore {
  readonly file: string;
  readonly #env: Record<string, string | undefined>;
  readonly #prefix: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: LocalSecretsStoreOptions) {
    this.file = options.file;
    this.#env = options.env ?? process.env;
    this.#prefix = options.prefix ?? SECRET_ENV_PREFIX;
  }

  async #read(): Promise<Record<string, string>> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw invalidFile();
    }
    if (text.trim() === '') return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw invalidFile();
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalidFile();
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (!LOCAL_SECRET_NAME.test(name) || typeof value !== 'string') throw invalidFile();
      result[name] = value;
    }
    return result;
  }

  /** Serialises writers inside this process so two edits cannot overwrite each other. */
  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  hasInEnvironment(name: string): boolean {
    const value = this.#env[secretEnvVarName(name, this.#prefix)];
    return value !== undefined && value !== '';
  }

  /** Names from the file and from the environment (environment names are shown normalised). */
  async describe(): Promise<LocalSecretEntry[]> {
    const fileNames = Object.keys(await this.#read());
    const entries = new Map<string, LocalSecretEntry>();
    for (const name of fileNames) {
      entries.set(normalizeSecretName(name), {
        name,
        inFile: true,
        inEnvironment: this.hasInEnvironment(name),
      });
    }
    for (const [key, value] of Object.entries(this.#env)) {
      if (!key.startsWith(this.#prefix) || typeof value !== 'string' || value === '') continue;
      const normalized = key.slice(this.#prefix.length);
      if (!entries.has(normalized))
        entries.set(normalized, { name: normalized, inFile: false, inEnvironment: true });
    }
    return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Creates or replaces a secret. The value is never logged, echoed or included in an error. */
  set(name: string, value: string): Promise<void> {
    if (!LOCAL_SECRET_NAME.test(name))
      throw new PlatformError(
        'VALIDATION_SCHEMA',
        'A secret name starts with a letter and has at most 64 letters, digits, "-" or "_".',
      );
    if (
      value === '' ||
      value.includes('\u0000') ||
      Buffer.byteLength(value) > MAX_LOCAL_SECRET_BYTES
    )
      throw new PlatformError(
        'VALIDATION_SCHEMA',
        `A secret value must be 1 to ${MAX_LOCAL_SECRET_BYTES} bytes and contain no null characters.`,
      );
    return this.#exclusive(async () => {
      const values = await this.#read();
      const key = normalizeSecretName(name);
      for (const existing of Object.keys(values))
        if (normalizeSecretName(existing) === key) delete values[existing];
      values[name] = value;
      await this.#write(values);
    });
  }

  /** Removes a secret from the file; false when it was not there. */
  remove(name: string): Promise<boolean> {
    return this.#exclusive(async () => {
      const values = await this.#read();
      const key = normalizeSecretName(name);
      const found = Object.keys(values).filter((existing) => normalizeSecretName(existing) === key);
      if (found.length === 0) return false;
      for (const existing of found) delete values[existing];
      await this.#write(values);
      return true;
    });
  }

  async #write(values: Record<string, string>): Promise<void> {
    await writeFileAtomic(this.file, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });
  }
}
