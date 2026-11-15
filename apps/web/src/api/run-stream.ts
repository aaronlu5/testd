import { watch, type Ref } from 'vue'
import { runsApi, suiteRunsApi } from '~/api/platform'
import { keys } from '~/api/queries'
import { useEventStream, type StreamState } from '~/api/event-stream'

export type { StreamState }

/** Run events, including the Phase 2 pause lifecycle. Each one refreshes the whole Run. */
export const RUN_EVENT_TYPES = [
  'run.status',
  'run.paused',
  'run.resumed',
  'run.cancelled',
  'run.step.updated',
  'step.status',
  'step.log',
  'artifact.created',
] as const

export const SUITE_RUN_EVENT_TYPES = ['suiteRun.updated'] as const

/** Follows a Run; a restart of the stream is triggered when the Run id changes. */
export const useRunStream = (runId: Ref<string>, active: Ref<boolean>) => {
  const stream = useEventStream(
    {
      url: () => runsApi.eventsUrl(runId.value),
      types: RUN_EVENT_TYPES,
      queryKey: () => [...keys.runs, 'detail', runId.value],
      // The pause inspection is read separately and must follow the same events.
      alsoRefresh: () => [[...keys.runs, 'pause', runId.value]],
    },
    active,
  )
  watch(runId, () => {
    if (active.value) stream.reopen()
  })
  return { state: stream.state }
}

export const useSuiteRunStream = (suiteRunId: Ref<string>, active: Ref<boolean>) => {
  const stream = useEventStream(
    {
      url: () => suiteRunsApi.eventsUrl(suiteRunId.value),
      types: SUITE_RUN_EVENT_TYPES,
      queryKey: () => [...keys.suiteRuns, 'detail', suiteRunId.value],
    },
    active,
  )
  watch(suiteRunId, () => {
    if (active.value) stream.reopen()
  })
  return { state: stream.state }
}
