import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm, link } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const RENAME_RETRIES = 10;
const RETRYABLE_RENAME_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES']);

const renameWithRetry = async (from: string, to: string): Promise<void> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows can briefly lock the target (antivirus, indexers); retry before giving up.
      if (attempt >= RENAME_RETRIES || !code || !RETRYABLE_RENAME_ERRORS.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
    }
  }
};

export type AtomicWriteOptions = {
  /** Fail with EEXIST instead of replacing an existing file (used for immutable versions). */
  exclusive?: boolean;
  /** POSIX permission bits for the new file (ignored on Windows), e.g. 0o600. */
  mode?: number;
};

/**
 * Writes to a temporary sibling, flushes it to disk, then renames over the target so readers
 * observe either the old or the new content, never a partial file.
 */
export const writeFileAtomic = async (
  path: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> => {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);

  try {
    const handle = await open(temporary, 'wx', options.mode);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (options.exclusive) {
      // link() fails with EEXIST if the target exists, so existing versions are never replaced.
      await link(temporary, path);
      await rm(temporary, { force: true });
    } else {
      await renameWithRetry(temporary, path);
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};
