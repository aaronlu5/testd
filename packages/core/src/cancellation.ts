import type { Run } from '@test-platform/contracts';
import { PlatformError } from './errors.js';

export const isCancellationRequested = (run: Pick<Run, 'status' | 'cancelRequestedAt'>): boolean =>
  run.cancelRequestedAt !== undefined || run.status === 'Cancelling' || run.status === 'Cancelled';

export const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted)
    throw new PlatformError('EXECUTION_CANCELLED', 'The operation was cancelled.');
};

/** Resolves after `ms`, or rejects with EXECUTION_CANCELLED as soon as the signal aborts. */
export const cancellableSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new PlatformError('EXECUTION_CANCELLED', 'The operation was cancelled.'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new PlatformError('EXECUTION_CANCELLED', 'The operation was cancelled.'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
