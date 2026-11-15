import { onScopeDispose, ref, watch, type Ref } from 'vue'
import { useQueryClient, type QueryKey } from '@tanstack/vue-query'

export type StreamState = 'idle' | 'live' | 'reconnecting' | 'polling'

export const MAX_STREAM_FAILURES = 3
const REFRESH_DEBOUNCE_MS = 100

export type EventStreamOptions = {
  /** Stream URL, read each time the stream is (re)opened. */
  url: () => string
  /** Event names to react to; unknown events are ignored. */
  types: readonly string[]
  /** The cached read model that every event, reconnect and end-of-stream refreshes in full. */
  queryKey: () => QueryKey
  /** Other cached data (for example the pause inspection) that depends on the same events. */
  alsoRefresh?: () => QueryKey[]
}

/**
 * Follows a resource over Server-Sent Events without trusting event history.
 *
 * Every event only triggers a full re-fetch of the resource, so the server stays the single source
 * of truth and a missed event cannot leave the screen wrong. After the connection drops and comes
 * back, the first thing that happens is the same full re-fetch. When the stream cannot be kept
 * open the state becomes `polling` and the caller's refetch interval takes over.
 */
export const useEventStream = (options: EventStreamOptions, active: Ref<boolean>) => {
  const client = useQueryClient()
  const state = ref<StreamState>('idle')
  let source: EventSource | undefined
  let failures = 0
  let pending: ReturnType<typeof setTimeout> | undefined

  const refreshNow = (): void => {
    void client.invalidateQueries({ queryKey: options.queryKey() })
    for (const key of options.alsoRefresh?.() ?? [])
      void client.invalidateQueries({ queryKey: key })
  }

  const refresh = (): void => {
    if (pending) return
    pending = setTimeout(() => {
      pending = undefined
      refreshNow()
    }, REFRESH_DEBOUNCE_MS)
  }

  const close = (next: StreamState = 'idle'): void => {
    source?.close()
    source = undefined
    state.value = next
  }

  const open = (): void => {
    close()
    if (typeof EventSource === 'undefined') {
      state.value = 'polling'
      return
    }
    failures = 0
    state.value = 'reconnecting'
    const stream = new EventSource(options.url())
    source = stream
    stream.onopen = () => {
      // Coming back after a failure: whatever was missed is recovered by one full re-fetch.
      const recovered = failures > 0
      failures = 0
      state.value = 'live'
      if (recovered) refreshNow()
    }
    for (const type of options.types) stream.addEventListener(type, refresh)
    stream.addEventListener('end', () => {
      refreshNow()
      close()
    })
    stream.onerror = () => {
      failures += 1
      if (stream.readyState === EventSource.CLOSED || failures >= MAX_STREAM_FAILURES) {
        close('polling')
      } else {
        state.value = 'reconnecting'
      }
    }
  }

  watch(
    active,
    (isActive) => {
      if (isActive) open()
      else close()
    },
    { immediate: true },
  )

  onScopeDispose(() => {
    close()
    if (pending) clearTimeout(pending)
  })

  return { state, reopen: open }
}
