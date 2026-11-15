import type {
  InspectedMessage,
  JsonObject,
  InspectorMessagePage,
  InspectorSummary,
  InspectorWatch,
  InspectorWatchInput,
} from '@test-platform/contracts';
import { PlatformError, createTargetPolicy, type AuditLog, type Clock } from '@test-platform/core';
import type { SqliteInspectorRepository } from '@test-platform/infrastructure-local';
import { notFound } from '../errors.js';
import type { EnvironmentService } from './environment-service.js';

const SUBSCRIPTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/;

type Deps = {
  environments: EnvironmentService;
  repository: SqliteInspectorRepository;
  audit: AuditLog;
  clock: Clock;
};

/**
 * Control-plane side of the Service Bus Inspector. It validates watches against the same
 * Environment allowlist a Step is held to (including the explicit `inspect` operation) and reads
 * what the worker collected. It never contacts Service Bus itself.
 */
export class InspectorService {
  readonly #deps: Deps;

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  summary(): InspectorSummary {
    return this.#deps.repository.summary();
  }

  async addWatch(input: InspectorWatchInput, actor: string): Promise<InspectorWatch> {
    const environment = await this.#deps.environments.require(input.environmentId);
    if (input.subscription !== undefined && !SUBSCRIPTION_NAME.test(input.subscription)) {
      throw new PlatformError('VALIDATION_SCHEMA', 'The subscription name is not valid.');
    }
    // Throws VALIDATION_TARGET_POLICY for an unknown target, a non-Service-Bus target, an entity
    // outside the allowlist, or a target that does not list "inspect".
    createTargetPolicy(environment).serviceBus(input.target, {
      entity: input.entity,
      operation: 'inspect',
    });
    const { watch, created } = this.#deps.repository.addWatch({
      ...input,
      source: 'manual',
      createdBy: actor,
    });
    if (created) await this.#audit(actor, 'inspector.watch.add', watch.id, input);
    return watch;
  }

  async removeWatch(id: string, actor: string): Promise<void> {
    if (!this.#deps.repository.removeWatch(id)) throw notFound(`Watch "${id}"`);
    await this.#audit(actor, 'inspector.watch.remove', id, {});
  }

  list(options: { limit?: number; before?: number; watchId?: string }): InspectorMessagePage {
    return this.#deps.repository.list(options);
  }

  get(id: string): InspectedMessage {
    const message = this.#deps.repository.get(id);
    if (!message) throw notFound(`Message "${id}"`);
    return message;
  }

  async clear(actor: string): Promise<{ cleared: number }> {
    const cleared = this.#deps.repository.clear();
    await this.#audit(actor, 'inspector.clear', 'all', { cleared });
    return { cleared };
  }

  markViewed(upToSeq: number): void {
    this.#deps.repository.markViewed(upToSeq);
  }

  async #audit(actor: string, action: string, entityId: string, metadata: object): Promise<void> {
    await this.#deps.audit.append({
      actor,
      action,
      entityType: 'service-bus-inspector',
      entityId,
      at: this.#deps.clock.now().toISOString(),
      metadata: metadata as JsonObject,
    });
  }
}
