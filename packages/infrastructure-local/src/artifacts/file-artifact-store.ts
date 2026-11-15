import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Artifact } from '@test-platform/contracts';
import {
  PlatformError,
  systemClock,
  type ArtifactStore,
  type ArtifactWrite,
  type Clock,
} from '@test-platform/core';
import { writeFileAtomic } from '../fs/atomic.js';
import { resolveInside } from '../fs/paths.js';
import { assertSafeId, newId, SAFE_ID } from '../ids.js';
import type { Database, Row } from '../sqlite/database.js';

export const DEFAULT_MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

export type FileArtifactStoreOptions = {
  artifactsDir: string;
  db: Database;
  clock?: Clock;
  maxBytes?: number;
};

const toArtifact = (row: Row): Artifact => ({
  id: row.id as string,
  runId: row.run_id as string,
  stepRunId: row.step_run_id as string,
  contentType: row.content_type as string,
  sizeBytes: row.size_bytes as number,
  sha256: row.sha256 as string,
  createdAt: row.created_at as string,
});

/**
 * Stores artifact bytes under `{runId}/{stepRunId}/{artifactId}`. Every segment is a generated
 * or validated identifier; no caller-supplied file name ever reaches the filesystem.
 */
export class FileArtifactStore implements ArtifactStore {
  readonly #root: string;
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #maxBytes: number;

  constructor(options: FileArtifactStoreOptions) {
    this.#root = options.artifactsDir;
    this.#db = options.db;
    this.#clock = options.clock ?? systemClock;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  }

  async write(input: ArtifactWrite): Promise<Artifact> {
    assertSafeId(input.runId, 'Run id');
    assertSafeId(input.stepRunId, 'Step run id');
    const bytes =
      typeof input.content === 'string' ? Buffer.from(input.content, 'utf8') : input.content;
    if (bytes.byteLength > this.#maxBytes) {
      throw new PlatformError(
        'EXECUTION_ARTIFACT',
        `Artifact exceeds the ${this.#maxBytes} byte limit.`,
      );
    }

    const id = newId();
    const relative = join(input.runId, input.stepRunId, id);
    const path = resolveInside(this.#root, input.runId, input.stepRunId, id);
    const artifact: Artifact = {
      id,
      runId: input.runId,
      stepRunId: input.stepRunId,
      contentType: input.contentType,
      sizeBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      createdAt: this.#clock.now().toISOString(),
    };

    await writeFileAtomic(path, bytes, { exclusive: true });
    try {
      this.#db
        .prepare(
          `INSERT INTO artifacts (id, run_id, step_run_id, path, content_type, size_bytes, sha256, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          artifact.runId,
          artifact.stepRunId,
          relative,
          artifact.contentType,
          artifact.sizeBytes,
          artifact.sha256,
          artifact.createdAt,
        );
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
    return artifact;
  }

  async get(artifactId: string): Promise<Artifact | undefined> {
    if (!SAFE_ID.test(artifactId)) return undefined;
    const row = this.#db.prepare('SELECT * FROM artifacts WHERE id = ?').get(artifactId) as
      Row | undefined;
    return row ? toArtifact(row) : undefined;
  }

  async read(artifactId: string): Promise<{ artifact: Artifact; content: Uint8Array } | undefined> {
    const artifact = await this.get(artifactId);
    if (!artifact) return undefined;

    // The path is rebuilt from validated ids rather than trusting the stored column.
    const path = resolveInside(this.#root, artifact.runId, artifact.stepRunId, artifact.id);
    let content: Buffer;
    try {
      content = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (createHash('sha256').update(content).digest('hex') !== artifact.sha256) {
      throw new PlatformError(
        'EXECUTION_ARTIFACT',
        'Artifact content does not match its recorded checksum.',
      );
    }
    return { artifact, content };
  }
}
