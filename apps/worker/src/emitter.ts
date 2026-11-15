import type { ArtifactReference, RunStatus, StepLogEntry, StepRun } from '@test-platform/contracts';
import type { Clock, EventPublisher } from '@test-platform/core';

/** Publishes Run events. Terminal Run events must be published before the terminal transition. */
export class RunEmitter {
  readonly #events: EventPublisher;
  readonly #clock: Clock;

  constructor(events: EventPublisher, clock: Clock) {
    this.#events = events;
    this.#clock = clock;
  }

  #at(): string {
    return this.#clock.now().toISOString();
  }

  runStatus(runId: string, status: RunStatus): Promise<void> {
    return this.#events.publish({
      type: 'run.status',
      runId,
      timestamp: this.#at(),
      data: { status },
    });
  }

  async stepStatus(
    step: Pick<StepRun, 'id' | 'runId' | 'nodeId' | 'attempt' | 'status'>,
  ): Promise<void> {
    const data = {
      stepRunId: step.id,
      nodeId: step.nodeId,
      attempt: step.attempt,
      status: step.status,
    };
    const timestamp = this.#at();
    await this.#events.publish({ type: 'step.status', runId: step.runId, timestamp, data });
    // Phase 2 consumers listen for the unified name; `step.status` stays for Phase 1 clients.
    await this.#events.publish({ type: 'run.step.updated', runId: step.runId, timestamp, data });
  }

  stepLog(runId: string, stepRunId: string, entry: StepLogEntry): Promise<void> {
    return this.#events.publish({
      type: 'step.log',
      runId,
      timestamp: this.#at(),
      data: { stepRunId, entry },
    });
  }

  artifactCreated(runId: string, stepRunId: string, artifact: ArtifactReference): Promise<void> {
    return this.#events.publish({
      type: 'artifact.created',
      runId,
      timestamp: this.#at(),
      data: { stepRunId, artifact },
    });
  }
}
