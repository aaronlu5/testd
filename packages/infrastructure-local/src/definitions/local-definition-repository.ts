import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join, posix } from 'node:path';
import {
  ASSET_SCHEMA_VERSION,
  findInlineSecrets,
  validateAsset,
  type AssetOf,
  type AssetType,
  type InlineSecretFinding,
  type JsonValue,
  type TestDefinition,
  type ValidationIssue,
} from '@test-platform/contracts';
import {
  PlatformError,
  normalizeTestLayout,
  systemClock,
  type AssetSummary,
  type AssetVersionRecord,
  type Clock,
  type DefinitionRepository,
  type ReconcileReport,
  type SaveAssetInput,
  type SaveAssetOptions,
  type StoredAsset,
} from '@test-platform/core';
import { writeFileAtomic } from '../fs/atomic.js';
import { resolveInside, slugify } from '../fs/paths.js';
import { assertSafeId } from '../ids.js';
import type { SqliteAssetIndex } from '../sqlite/asset-index.js';

const DIRECTORIES: Record<AssetType, string> = {
  test: 'tests',
  'test-data': 'test-data',
  suite: 'suites',
  'mock-setup': 'mock-setups',
};
const HISTORY_DIR = '.versions';

export const hashContent = (content: string | Uint8Array): string =>
  createHash('sha256').update(content).digest('hex');

const findAssetSecrets = (type: AssetType, asset: unknown): InlineSecretFinding[] => {
  const record = asset as Record<string, unknown>;
  if (type === 'test') {
    const test = asset as TestDefinition;
    return [
      ...test.nodes.flatMap((node, index) =>
        findInlineSecrets(
          node.parameters,
          { rejectSecretKeys: true },
          `/nodes/${index}/parameters`,
        ),
      ),
      ...findInlineSecrets(test.variables, { rejectSecretKeys: true }, '/variables'),
    ];
  }
  if (type === 'test-data') return findInlineSecrets(record.data as JsonValue, {}, '/data');
  return [];
};

const serialize = (asset: unknown): string => `${JSON.stringify(asset, null, 2)}\n`;

type LoadedAsset = { asset: AssetOf<AssetType>; contentHash: string; relativePath: string };

export type LocalDefinitionRepositoryOptions = {
  definitionsDir: string;
  index: SqliteAssetIndex;
  clock?: Clock;
};

/**
 * Stores portable assets as JSON files (authoritative) and mirrors them into the SQLite index.
 * Current content lives in `<dir>/<slug>--<id>.json`; every saved version is also written once,
 * exclusively, to `<dir>/.versions/<id>/v<version>.json`.
 */
export class LocalDefinitionRepository implements DefinitionRepository {
  readonly #root: string;
  readonly #index: SqliteAssetIndex;
  readonly #clock: Clock;

  constructor(options: LocalDefinitionRepositoryOptions) {
    this.#root = options.definitionsDir;
    this.#index = options.index;
    this.#clock = options.clock ?? systemClock;
  }

  async ensureDirectories(): Promise<void> {
    await Promise.all(
      Object.values(DIRECTORIES).map((dir) => mkdir(join(this.#root, dir), { recursive: true })),
    );
  }

  async list(
    type: AssetType,
    filter: { tag?: string; search?: string } = {},
  ): Promise<AssetSummary[]> {
    const search = filter.search?.toLowerCase();
    return this.#index
      .list(type)
      .filter((entry) => (filter.tag ? entry.tags.includes(filter.tag) : true))
      .filter((entry) =>
        search
          ? entry.name.toLowerCase().includes(search) || entry.id.toLowerCase() === search
          : true,
      )
      .map((entry) => ({
        id: entry.id,
        type: entry.type,
        name: entry.name,
        tags: entry.tags,
        currentVersion: entry.currentVersion,
        contentHash: entry.contentHash,
        updatedAt: entry.updatedAt,
      }));
  }

  async get<T extends AssetType>(
    type: T,
    id: string,
    version?: number,
  ): Promise<StoredAsset<T> | undefined> {
    assertSafeId(id, 'Asset id');
    const current = await this.#loadCurrent(type, id);
    if (!current) return undefined;
    if (version === undefined || version === current.asset.version) {
      return { type, asset: current.asset as AssetOf<T>, contentHash: current.contentHash };
    }
    const historical = await this.#readFile(type, this.#historyPath(type, id, version));
    return historical
      ? { type, asset: historical.asset as AssetOf<T>, contentHash: historical.contentHash }
      : undefined;
  }

  async save<T extends AssetType>(
    type: T,
    input: SaveAssetInput<T>,
    options: SaveAssetOptions,
  ): Promise<StoredAsset<T>> {
    const draft = input as unknown as Record<string, unknown> & { id: string };
    assertSafeId(draft.id, 'Asset id');

    const current = await this.#loadCurrent(type, draft.id);
    const currentVersion = current?.asset.version ?? 0;
    if ((options.expectedVersion ?? 0) !== currentVersion) {
      throw new PlatformError(
        'VALIDATION_CONFLICT',
        `Expected version ${options.expectedVersion ?? 0} but the stored version is ${currentVersion}.`,
      );
    }

    const now = this.#clock.now().toISOString();
    const version = currentVersion + 1;
    const {
      schemaVersion = ASSET_SCHEMA_VERSION,
      id,
      name,
      description,
      tags,
      ...content
    } = draft as Record<string, unknown>;
    const asset = {
      schemaVersion,
      id,
      version,
      name,
      ...(description !== undefined ? { description } : {}),
      tags,
      metadata: {
        createdAt: current?.asset.metadata.createdAt ?? now,
        createdBy: current?.asset.metadata.createdBy ?? options.actor,
        updatedAt: now,
        updatedBy: options.actor,
      },
      ...content,
    };

    const checked = validateAsset(type, asset);
    if (!checked.valid) {
      throw new PlatformError('VALIDATION_SCHEMA', 'The definition does not match its schema.', {
        issues: checked.issues,
      });
    }

    // Secrets are referenced by name; a credential-shaped value is never written to disk.
    const secretFindings = findAssetSecrets(type, asset);
    if (secretFindings.length > 0) {
      throw new PlatformError(
        'VALIDATION_INLINE_SECRET',
        'The definition contains a value that looks like a secret.',
        {
          issues: secretFindings.map((finding) => ({
            path: finding.path,
            message: 'Reference a Key Vault or local secret by name instead of storing its value.',
            keyword: finding.reason,
          })),
        },
      );
    }

    // Position-managed Tests persist the server-normalized order and edges, never client edges.
    if (type === 'test') {
      const normalized = normalizeTestLayout(asset as unknown as TestDefinition);
      if (normalized.issues.length > 0) {
        throw new PlatformError('VALIDATION_FLOW', 'The Test layout is not valid.', {
          issues: normalized.issues.map((issue) => ({
            path: '/nodes',
            message: issue.message,
            keyword: issue.code,
          })),
        });
      }
      (asset as { edges?: unknown }).edges = normalized.test.edges;
    }

    const text = serialize(asset);
    const contentHash = hashContent(text);
    const relativePath =
      current?.relativePath ??
      posix.join(DIRECTORIES[type], `${slugify(String(name))}--${draft.id}.json`);

    try {
      await writeFileAtomic(this.#absolute(this.#historyPath(type, draft.id, version)), text, {
        exclusive: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new PlatformError(
          'VALIDATION_CONFLICT',
          `Version ${version} was saved concurrently; reload and retry.`,
        );
      }
      throw error;
    }
    await writeFileAtomic(this.#absolute(relativePath), text);

    this.#index.record(
      {
        type,
        id: draft.id,
        version,
        path: relativePath,
        name: String(name),
        tags: tags as string[],
        contentHash,
        updatedAt: now,
      },
      {
        type,
        id: draft.id,
        version,
        contentHash,
        path: this.#historyRelative(type, draft.id, version),
        createdAt: now,
        createdBy: options.actor,
      },
    );
    return { type, asset: asset as unknown as AssetOf<T>, contentHash };
  }

  async listVersions(type: AssetType, id: string): Promise<AssetVersionRecord[]> {
    assertSafeId(id, 'Asset id');
    return this.#index.versions(type, id);
  }

  async delete(type: AssetType, id: string): Promise<boolean> {
    assertSafeId(id, 'Asset id');
    const current = await this.#loadCurrent(type, id);
    if (!current) return false;
    await rm(this.#absolute(current.relativePath), { force: true });
    await rm(resolveInside(this.#root, DIRECTORIES[type], HISTORY_DIR, id), {
      recursive: true,
      force: true,
    });
    this.#index.remove(type, id);
    return true;
  }

  async reconcile(): Promise<ReconcileReport> {
    const report: ReconcileReport = {
      added: [],
      updated: [],
      removed: [],
      unchanged: 0,
      invalid: [],
    };

    for (const type of Object.keys(DIRECTORIES) as AssetType[]) {
      const directory = join(this.#root, DIRECTORIES[type]);
      await mkdir(directory, { recursive: true });
      const files = (await readdir(directory, { withFileTypes: true }))
        .filter(
          (entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.'),
        )
        .map((entry) => entry.name)
        .sort();

      const seen = new Set<string>();
      for (const file of files) {
        const relativePath = posix.join(DIRECTORIES[type], file);
        let loaded: LoadedAsset | undefined;
        try {
          loaded = await this.#readFile(type, relativePath);
        } catch (error) {
          const issues: ValidationIssue[] =
            error instanceof PlatformError && error.issues.length > 0
              ? error.issues
              : [{ path: '', message: error instanceof Error ? error.message : 'Unreadable file' }];
          report.invalid.push({ path: relativePath, issues });
          continue;
        }
        if (!loaded) continue;
        const { asset, contentHash } = loaded;
        if (!file.endsWith(`${asset.id}.json`) || seen.has(asset.id)) {
          report.invalid.push({
            path: relativePath,
            issues: [
              {
                path: '/id',
                message: seen.has(asset.id)
                  ? `duplicate id ${asset.id}`
                  : 'file name does not end with the asset id',
              },
            ],
          });
          continue;
        }
        seen.add(asset.id);

        const indexed = this.#index.get(type, asset.id);
        const updatedAt = asset.metadata.updatedAt ?? asset.metadata.createdAt;
        if (!indexed) report.added.push(relativePath);
        else if (
          indexed.contentHash !== contentHash ||
          indexed.path !== relativePath ||
          indexed.currentVersion !== asset.version
        ) {
          report.updated.push(relativePath);
        } else report.unchanged += 1;

        if (
          !indexed ||
          indexed.contentHash !== contentHash ||
          indexed.path !== relativePath ||
          indexed.currentVersion !== asset.version
        ) {
          await this.#ensureHistory(type, asset.id, asset.version, serialize(asset));
          this.#index.record(
            {
              type,
              id: asset.id,
              version: asset.version,
              path: relativePath,
              name: asset.name,
              tags: asset.tags,
              contentHash,
              updatedAt,
            },
            {
              type,
              id: asset.id,
              version: asset.version,
              contentHash,
              path: this.#historyRelative(type, asset.id, asset.version),
              createdAt: updatedAt,
              createdBy: asset.metadata.updatedBy ?? asset.metadata.createdBy,
            },
          );
          await this.#recordHistory(type, asset.id);
        }
      }

      for (const entry of this.#index.list(type)) {
        if (!seen.has(entry.id) && !report.invalid.some((item) => item.path === entry.path)) {
          this.#index.remove(type, entry.id);
          report.removed.push(entry.path);
        }
      }
    }
    return report;
  }

  /** Registers every valid `v<N>.json` copy on disk that the index does not know yet. */
  async #recordHistory(type: AssetType, id: string): Promise<void> {
    const directory = resolveInside(this.#root, DIRECTORIES[type], HISTORY_DIR, id);
    const names = await readdir(directory).catch(() => [] as string[]);
    const known = new Set(this.#index.versions(type, id).map((record) => record.version));
    for (const name of names) {
      const match = /^v(\d+)\.json$/.exec(name);
      const version = match ? Number(match[1]) : undefined;
      if (version === undefined || known.has(version)) continue;
      const relativePath = this.#historyRelative(type, id, version);
      const loaded = await this.#readFile(type, relativePath).catch(() => undefined);
      if (!loaded || loaded.asset.id !== id || loaded.asset.version !== version) continue;
      this.#index.recordVersion({
        type,
        id,
        version,
        contentHash: loaded.contentHash,
        path: relativePath,
        createdAt: loaded.asset.metadata.updatedAt ?? loaded.asset.metadata.createdAt,
        createdBy: loaded.asset.metadata.updatedBy ?? loaded.asset.metadata.createdBy,
      });
    }
  }

  #absolute(relativePath: string): string {
    return resolveInside(this.#root, relativePath);
  }

  #historyRelative(type: AssetType, id: string, version: number): string {
    return posix.join(DIRECTORIES[type], HISTORY_DIR, id, `v${version}.json`);
  }

  #historyPath(type: AssetType, id: string, version: number): string {
    return this.#historyRelative(type, id, version);
  }

  /** Writes the immutable history copy if absent; an existing copy is never replaced. */
  async #ensureHistory(type: AssetType, id: string, version: number, text: string): Promise<void> {
    try {
      await writeFileAtomic(this.#absolute(this.#historyPath(type, id, version)), text, {
        exclusive: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  async #readFile(type: AssetType, relativePath: string): Promise<LoadedAsset | undefined> {
    let text: string;
    try {
      text = await readFile(this.#absolute(relativePath), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const checked = validateAsset(type, JSON.parse(text));
    if (!checked.valid) {
      throw new PlatformError(
        'VALIDATION_SCHEMA',
        `Stored definition ${relativePath} does not match its schema.`,
        { issues: checked.issues },
      );
    }
    return { asset: checked.value, contentHash: hashContent(text), relativePath };
  }

  async #loadCurrent(type: AssetType, id: string): Promise<LoadedAsset | undefined> {
    const indexed = this.#index.get(type, id);
    if (indexed) {
      const loaded = await this.#readFile(type, indexed.path);
      if (loaded) return loaded;
    }
    // Index missing or stale (for example before reconciliation): fall back to the directory.
    const directory = join(this.#root, DIRECTORIES[type]);
    const names = await readdir(directory).catch(() => [] as string[]);
    const match = names.find((name) => !name.startsWith('.') && name.endsWith(`--${id}.json`));
    return match ? this.#readFile(type, posix.join(DIRECTORIES[type], match)) : undefined;
  }
}
