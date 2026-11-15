import type {
  Artifact,
  PausedStepSummary,
  RunDetail,
  RunPause,
  RunKind,
  RunStatus,
  RunSummary,
  StepRun,
} from '@test-platform/contracts';
import { PlatformError } from '@test-platform/core';
import type {
  ArtifactStore,
  RunEventSource,
  RunFilter,
  RunPauseRepository,
  RunRepository,
} from '@test-platform/core';
import { notFound } from '../errors.js';
import type { Identity } from '../security.js';
import { summarizeEnvironment } from './environment-service.js';
import { toSummary } from './run-service.js';

export type RunQuery = {
  status?: RunStatus;
  kind?: RunKind;
  testId?: string;
  environmentId?: string;
  limit?: number;
  offset?: number;
};

/** Read-side access to Runs, Step Runs, events, and artifacts. */
export class RunQueryService {
  readonly #runs: RunRepository;
  readonly #artifacts: ArtifactStore;
  readonly #events: RunEventSource;
  readonly #pauses: RunPauseRepository;

  constructor(
    runs: RunRepository,
    artifacts: ArtifactStore,
    events: RunEventSource,
    pauses: RunPauseRepository,
  ) {
    this.#runs = runs;
    this.#artifacts = artifacts;
    this.#events = events;
    this.#pauses = pauses;
  }

  async list(query: RunQuery): Promise<RunSummary[]> {
    const filter: RunFilter = { ...query };
    return (await this.#runs.listRuns(filter)).map(toSummary);
  }

  async detail(id: string): Promise<RunDetail> {
    // The sequence is read first: a client resuming from it can only see events twice, never miss one.
    const lastEventSeq = await this.#events.lastSeq(id);
    const run = await this.#runs.getRun(id);
    if (!run) throw notFound(`Run "${id}"`);
    const { environment, ...snapshots } = run.snapshots;
    return {
      ...toSummary(run),
      // Always present in the detail, so clients never treat a missing value as unknown.
      continuationGeneration: run.continuationGeneration ?? 0,
      snapshots: { ...snapshots, environment: summarizeEnvironment(environment) },
      stepRuns: await this.#runs.listStepRuns(id),
      lastEventSeq,
    };
  }

  /**
   * The active Breakpoint pause with summaries of the Steps completed before it. 404 unless the
   * Run is currently paused. Callers mask the result; artifacts are referenced by id only.
   */
  async pauseInspection(id: string): Promise<{
    run: Pick<RunSummary, 'id' | 'status' | 'pausedAt' | 'continuationGeneration'> & {
      continuationGeneration: number;
    };
    pause: RunPause;
    completedSteps: PausedStepSummary[];
    lastEventSeq: number;
  }> {
    const lastEventSeq = await this.#events.lastSeq(id);
    const run = await this.#runs.getRun(id);
    if (!run) throw notFound(`Run "${id}"`);
    const pause = run.status === 'Paused' ? await this.#pauses.getActivePause(id) : undefined;
    if (!pause) {
      throw new PlatformError('VALIDATION_NOT_FOUND', `Run "${id}" is not paused.`);
    }
    return {
      run: {
        id: run.id,
        status: run.status,
        ...(run.pausedAt ? { pausedAt: run.pausedAt } : {}),
        continuationGeneration: run.continuationGeneration ?? 0,
      },
      pause,
      completedSteps: await this.#pauses.listCompletedSteps(id),
      lastEventSeq,
    };
  }

  async requireRun(id: string): Promise<RunSummary> {
    const run = await this.#runs.getRun(id);
    if (!run) throw notFound(`Run "${id}"`);
    return toSummary(run);
  }

  async stepRun(runId: string, stepRunId: string): Promise<StepRun> {
    const step = await this.#runs.getStepRun(stepRunId);
    if (!step || step.runId !== runId) throw notFound(`Step run "${stepRunId}"`);
    return step;
  }

  async currentStatus(id: string): Promise<RunStatus | undefined> {
    return (await this.#runs.getRun(id))?.status;
  }

  events(runId: string, afterSeq: number, limit: number) {
    return this.#events.listSince(runId, afterSeq, limit);
  }

  /**
   * Local development has one identity that may read every Run's artifacts. The check lives here
   * so a real identity provider can narrow access without touching the routes.
   */
  async #authorize(_identity: Identity, artifact: Artifact): Promise<void> {
    if (!(await this.#runs.getRun(artifact.runId))) throw notFound(`Artifact "${artifact.id}"`);
  }

  async artifactMetadata(identity: Identity, id: string): Promise<Artifact> {
    const artifact = await this.#artifacts.get(id);
    if (!artifact) throw notFound(`Artifact "${id}"`);
    await this.#authorize(identity, artifact);
    return artifact;
  }

  async artifactContent(
    identity: Identity,
    id: string,
  ): Promise<{ artifact: Artifact; content: Uint8Array }> {
    const artifact = await this.artifactMetadata(identity, id);
    const stored = await this.#artifacts.read(artifact.id);
    if (!stored) throw notFound(`Artifact "${id}"`);
    return stored;
  }
}
