import { METRICS, type Logger, type MetricsSink } from '@test-platform/core';
import type { LocalInfrastructure } from '@test-platform/infrastructure-local';

type Deps = {
  infra: Pick<LocalInfrastructure, 'suiteRuns' | 'suiteCommands'>;
  logger: Logger;
  metrics?: MetricsSink;
};

/**
 * Drives every unfinished Suite Run one step forward per tick. All decisions are re-derived from
 * the database inside one transaction per Suite Run, so the scheduler keeps no state of its own:
 * after a restart it simply picks up where the tables say things stand, and it can never dispatch
 * more children than the Suite Run allows.
 */
export class SuiteScheduler {
  readonly #deps: Deps;

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  /** Returns how many child Runs were dispatched. */
  async tick(): Promise<number> {
    const { infra, logger } = this.#deps;
    let dispatched = 0;
    for (const suiteRun of await infra.suiteRuns.listActiveSuiteRuns()) {
      try {
        const result = await infra.suiteCommands.advance(suiteRun.id);
        if (!result) continue;
        dispatched += result.dispatched.length;
        if (result.dispatched.length > 0)
          this.#deps.metrics?.increment(METRICS.suiteDispatched, {}, result.dispatched.length);
        if (result.changed) {
          this.#deps.metrics?.increment(METRICS.suiteAdvanced, { status: result.suiteRun.status });
          logger.info('Suite Run advanced', {
            suiteRunId: suiteRun.id,
            status: result.suiteRun.status,
            dispatched: result.dispatched.length,
          });
        }
      } catch (error) {
        // One broken Suite Run must not stop the others; it is retried on the next tick.
        logger.error('Suite Run could not be advanced', {
          suiteRunId: suiteRun.id,
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
    return dispatched;
  }
}
