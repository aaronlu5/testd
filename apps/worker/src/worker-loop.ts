import { METRICS, type Clock, type Job, type Logger, type MetricsSink } from '@test-platform/core';
import type { LocalInfrastructure } from '@test-platform/infrastructure-local';
import type { WorkerConfig } from './config.js';
import { LeaseRenewer } from './lease-renewer.js';
import type { JobDisposition, RunExecutor } from './run-executor.js';

type Deps = {
  config: WorkerConfig;
  infra: Pick<LocalInfrastructure, 'jobs'>;
  executor: Pick<RunExecutor, 'execute'>;
  /** Advances Suite Runs; optional so Test-only workers and unit tests can omit it. */
  scheduler?: { tick(): Promise<number> };
  clock: Clock;
  logger: Logger;
  metrics?: MetricsSink;
};

type Active = {
  job: Job;
  done: Promise<void>;
  interrupt: AbortController;
};

/**
 * Claims one job at a time, keeps its lease alive while the Run executes, and sweeps expired
 * leases. A job that is never finished (crash, power loss) simply expires and is requeued.
 */
export class WorkerLoop {
  readonly #deps: Deps;
  readonly #wake = new AbortController();
  #stopping = false;
  #loop: Promise<void> | undefined;
  #active: Active | undefined;
  #lastReapMs = Number.NEGATIVE_INFINITY;
  #lastPollAt: number | undefined;

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  /** Last time the loop completed an iteration, for readiness checks. */
  get lastPollAt(): number | undefined {
    return this.#lastPollAt;
  }

  get activeJobId(): string | undefined {
    return this.#active?.job.id;
  }

  start(): void {
    if (this.#loop) return;
    this.#loop = this.#run();
  }

  async #run(): Promise<void> {
    const { config, logger } = this.#deps;
    while (!this.#stopping) {
      let worked = false;
      try {
        worked = await this.runOnce();
      } catch (error) {
        logger.error('Worker iteration failed', {
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
      if (!worked && !this.#stopping) await this.#sleep(config.pollIntervalMs);
    }
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const signal = this.#wake.signal;
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    });
  }

  /** Sweeps expired leases when due, then claims and processes at most one job. */
  async runOnce(): Promise<boolean> {
    const { config, infra, clock, logger } = this.#deps;
    const nowMs = clock.now().getTime();
    this.#lastPollAt = nowMs;

    if (nowMs - this.#lastReapMs >= config.reaperIntervalMs) {
      this.#lastReapMs = nowMs;
      const recovered = await infra.jobs.recoverExpired();
      if (recovered.requeued > 0 || recovered.failed > 0) {
        logger.warn('Recovered jobs with expired leases', recovered);
        this.#deps.metrics?.increment(
          METRICS.jobsRecovered,
          { kind: 'requeued' },
          recovered.requeued,
        );
        this.#deps.metrics?.increment(METRICS.jobsRecovered, { kind: 'failed' }, recovered.failed);
      }
    }

    if (this.#stopping) return false;
    // Dispatch before claiming so a child Run created now can be picked up in this iteration.
    await this.#deps.scheduler?.tick();
    const job = await infra.jobs.claim({ workerId: config.workerId, leaseMs: config.leaseMs });
    if (!job) return false;
    this.#deps.metrics?.increment(METRICS.jobsClaimed);
    await this.#process(job);
    return true;
  }

  async #process(job: Job): Promise<void> {
    const { config, infra, executor, logger } = this.#deps;
    const log = logger.child({ jobId: job.id, runId: job.runId });
    const interrupt = new AbortController();
    const renewer = new LeaseRenewer({
      jobs: infra.jobs,
      jobId: job.id,
      workerId: config.workerId,
      leaseMs: config.leaseMs,
      intervalMs: config.leaseRenewIntervalMs,
      logger: log,
      onLost: () => interrupt.abort('lease-lost'),
    });

    const work = async (): Promise<void> => {
      renewer.start();
      try {
        log.info('Job claimed', { attempt: job.attempts, maxAttempts: job.maxAttempts });
        const disposition = await executor.execute(job, interrupt.signal);
        await this.#settle(job, disposition);
      } catch (error) {
        // Leave the lease to expire: recovery requeues the job until its attempts run out.
        log.error('Job processing failed; the lease will expire and the job will be retried', {
          error: error instanceof Error ? error.message : 'unknown',
        });
      } finally {
        renewer.stop();
      }
    };

    const done = work();
    this.#active = { job, done, interrupt };
    try {
      await done;
    } finally {
      this.#active = undefined;
    }
  }

  async #settle(job: Job, disposition: JobDisposition): Promise<void> {
    const { config, infra, clock, logger } = this.#deps;
    const input = { jobId: job.id, workerId: config.workerId };
    let outcome: string;
    switch (disposition.kind) {
      case 'complete':
        outcome = await infra.jobs.complete(input);
        break;
      case 'fail':
        outcome = await infra.jobs.fail({ ...input, error: disposition.error });
        break;
      case 'release':
        outcome = await infra.jobs.reschedule({
          ...input,
          availableAt: clock.now().toISOString(),
          error: 'Released by a worker that was shutting down.',
        });
        break;
      case 'abandon':
        outcome = 'abandoned';
        break;
    }
    logger.info('Job settled', { jobId: job.id, disposition: disposition.kind, outcome });
  }

  /**
   * Stops claiming, lets the current Run finish within the grace period, then interrupts it and
   * hands the job back. The Run stays Running and the next claim resumes it.
   */
  async stop(graceMs: number = this.#deps.config.shutdownGraceMs): Promise<void> {
    this.#stopping = true;
    this.#wake.abort();

    const active = this.#active;
    if (active) {
      let timer: NodeJS.Timeout | undefined;
      const expired = new Promise<'expired'>((resolve) => {
        timer = setTimeout(() => resolve('expired'), graceMs);
      });
      const winner = await Promise.race([active.done.then(() => 'done' as const), expired]);
      clearTimeout(timer);
      if (winner === 'expired') {
        this.#deps.logger.warn('Grace period elapsed; interrupting the active Run', {
          jobId: active.job.id,
        });
        active.interrupt.abort('shutdown');
        await active.done;
      }
    }
    await this.#loop;
  }
}
