import { readFile, stat } from 'node:fs/promises';
import {
  validateEnvironmentsFile,
  type EnvironmentConfig,
  type InspectorWatch,
} from '@test-platform/contracts';
import {
  METRICS,
  PlatformError,
  assertConnectionStringMatches,
  createTargetPolicy,
  mapTargetFailure,
  noopMetrics,
  validateEnvironmentTargets,
  type Clock,
  type Logger,
  type MetricsSink,
  type TargetClients,
} from '@test-platform/core';
import type { LocalInfrastructure } from '@test-platform/infrastructure-local';

const PEEK_BATCH = 50;
/** Batches drained per watch per tick, so one busy entity cannot starve the others. */
const MAX_BATCHES_PER_TICK = 4;
const PEEK_TIMEOUT_MS = 20_000;
const FAILURE_BACKOFF_MS = 30_000;

type Deps = {
  infra: Pick<LocalInfrastructure, 'inspector' | 'secrets'>;
  clients: TargetClients;
  clock: Clock;
  logger: Logger;
  environmentsFile: string;
  pollMs: number;
  metrics?: MetricsSink;
};

/**
 * Reads the Environment file for the inspector. Runs never use it (they use their own
 * snapshots); the inspector needs the *current* target configuration because a watch outlives
 * any single Run. Re-read when the file changes; an invalid file yields no Environments.
 */
export class EnvironmentFile {
  readonly #file: string;
  #cache?: { mtimeMs: number; size: number; environments: EnvironmentConfig[] };

  constructor(file: string) {
    this.#file = file;
  }

  async get(id: string): Promise<EnvironmentConfig | undefined> {
    const info = await stat(this.#file);
    if (!this.#cache || this.#cache.mtimeMs !== info.mtimeMs || this.#cache.size !== info.size) {
      const parsed = validateEnvironmentsFile(JSON.parse(await readFile(this.#file, 'utf8')));
      const environments = parsed.valid ? parsed.value.environments : [];
      const safe = environments.filter(
        (environment) => validateEnvironmentTargets(environment).length === 0,
      );
      this.#cache = { mtimeMs: info.mtimeMs, size: info.size, environments: safe };
    }
    return this.#cache.environments.find((environment) => environment.id === id);
  }
}

/**
 * Peeks at every registered watch on a timer and stores what it sees. It only peeks: nothing is
 * received, completed, abandoned or deleted, so it cannot take a message from the real consumer.
 * Secrets are resolved just before a peek and the client is closed straight afterwards.
 */
export class InspectorService {
  readonly #deps: Deps;
  readonly #environments: EnvironmentFile;
  readonly #retryAt = new Map<string, number>();
  #timer?: NodeJS.Timeout;
  #running?: Promise<void>;
  #stopping = false;
  readonly #abort = new AbortController();

  constructor(deps: Deps) {
    this.#deps = deps;
    this.#environments = new EnvironmentFile(deps.environmentsFile);
  }

  start(): void {
    if (this.#timer) return;
    const tick = (): void => {
      if (this.#stopping) return;
      this.#running = this.tick()
        .then(() => undefined)
        .catch((error: unknown) => {
          this.#deps.logger.error('Inspector tick failed', {
            error: error instanceof Error ? error.message : 'unknown',
          });
        })
        .finally(() => {
          if (!this.#stopping) {
            this.#timer = setTimeout(tick, this.#deps.pollMs);
            this.#timer.unref();
          }
        });
    };
    this.#timer = setTimeout(tick, 1_000);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#abort.abort();
    if (this.#timer) clearTimeout(this.#timer);
    await this.#running;
  }

  /** One pass over all watches; also called directly by tests. Returns messages stored. */
  async tick(): Promise<number> {
    let stored = 0;
    for (const watch of this.#deps.infra.inspector.listWatches()) {
      if (this.#stopping) break;
      const retryAt = this.#retryAt.get(watch.id);
      if (retryAt !== undefined && this.#deps.clock.now().getTime() < retryAt) continue;
      try {
        stored += await this.#poll(watch);
        this.#retryAt.delete(watch.id);
        this.#deps.infra.inspector.recordPollSuccess(watch.id);
      } catch (error) {
        const code = error instanceof PlatformError ? error.code : 'SYSTEM_INTERNAL';
        this.#deps.infra.inspector.recordPollFailure(watch.id, code);
        this.#retryAt.set(watch.id, this.#deps.clock.now().getTime() + FAILURE_BACKOFF_MS);
        (this.#deps.metrics ?? noopMetrics).increment(METRICS.inspectorPollFailures, { code });
        // The error text is deliberately not logged: SDK messages can quote connection details.
        this.#deps.logger.warn('Inspector peek failed', { watchId: watch.id, code });
      }
    }
    return stored;
  }

  async #poll(watch: InspectorWatch): Promise<number> {
    const { infra, clients } = this.#deps;
    const environment = await this.#environments.get(watch.environmentId);
    if (!environment)
      throw new PlatformError(
        'VALIDATION_REFERENCE',
        `Environment "${watch.environmentId}" is not configured.`,
      );
    // Same allowlist rules as a Step: the entity and the `inspect` operation must be approved.
    const plan = createTargetPolicy(environment).serviceBus(watch.target, {
      entity: watch.entity,
      operation: 'inspect',
    });

    let connectionString: string | undefined;
    if (plan.target.credential) {
      connectionString = await infra.secrets.resolve(plan.target.credential);
      assertConnectionStringMatches(
        'azureServiceBus',
        connectionString,
        plan.fullyQualifiedNamespace,
      );
    }
    const client = clients.openServiceBus({
      fullyQualifiedNamespace: plan.fullyQualifiedNamespace,
      ...(connectionString ? { connectionString } : {}),
    });
    const timeout = AbortSignal.timeout(PEEK_TIMEOUT_MS);
    const signal = AbortSignal.any([timeout, this.#abort.signal]);
    let stored = 0;
    try {
      for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch += 1) {
        const cursor = infra.inspector.getCursor(watch.id);
        const messages = await client
          .peek({
            entity: watch.entity,
            ...(watch.subscription ? { subscription: watch.subscription } : {}),
            ...(cursor ? { fromSequenceNumber: (BigInt(cursor) + 1n).toString() } : {}),
            maxMessages: PEEK_BATCH,
            signal,
          })
          .catch((error: unknown) => {
            throw mapTargetFailure(error, 'Service Bus peek');
          });
        const fresh = infra.inspector.storePeeked(watch, messages);
        stored += fresh;
        (this.#deps.metrics ?? noopMetrics).increment(
          METRICS.inspectorMessages,
          { origin: 'received' },
          fresh,
        );
        if (messages.length < PEEK_BATCH) break;
      }
    } finally {
      await client.close().catch(() => undefined);
    }
    return stored;
  }
}
