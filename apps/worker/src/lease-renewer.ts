import type { JobQueue, Logger } from '@test-platform/core';

export type LeaseRenewerOptions = {
  jobs: Pick<JobQueue, 'renewLease'>;
  jobId: string;
  workerId: string;
  leaseMs: number;
  intervalMs: number;
  logger: Logger;
  /** Called once when the lease is confirmed lost; the Run must stop writing. */
  onLost: () => void;
};

/** Extends the job lease while a Run executes. Transient errors are retried on the next tick. */
export class LeaseRenewer {
  readonly #options: LeaseRenewerOptions;
  #timer: NodeJS.Timeout | undefined;
  #busy = false;
  #lost = false;

  constructor(options: LeaseRenewerOptions) {
    this.#options = options;
  }

  get lost(): boolean {
    return this.#lost;
  }

  start(): void {
    this.#timer = setInterval(() => void this.#renew(), this.#options.intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async #renew(): Promise<void> {
    if (this.#busy || this.#lost) return;
    this.#busy = true;
    const { jobs, jobId, workerId, leaseMs, logger, onLost } = this.#options;
    try {
      const renewed = await jobs.renewLease({ jobId, workerId, leaseMs });
      if (!renewed) {
        this.#lost = true;
        this.stop();
        logger.warn('Job lease was lost; abandoning the Run', { jobId });
        onLost();
      }
    } catch (error) {
      logger.warn('Lease renewal failed; will retry', {
        jobId,
        error: error instanceof Error ? error.message : 'unknown',
      });
    } finally {
      this.#busy = false;
    }
  }
}
