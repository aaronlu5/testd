import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { MAX_STREAM_FAILURES } from '~/api/event-stream'
import { useRunStream, useSuiteRunStream } from '~/api/run-stream'

type Listener = () => void

class FakeEventSource {
  static instances: FakeEventSource[] = []
  static readonly CLOSED = 2
  readyState = 0
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  private listeners = new Map<string, Listener[]>()
  constructor(public url: string) {
    FakeEventSource.instances.push(this)
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  close() {
    this.closed = true
    this.readyState = FakeEventSource.CLOSED
  }
  // test helpers
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  fail(permanently = false) {
    if (permanently) this.readyState = FakeEventSource.CLOSED
    this.onerror?.()
  }
  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }
}

const RUN_DETAIL = ['runs', 'detail', 'run-1']
const RUN_PAUSE = ['runs', 'pause', 'run-1']

const setup = (kind: 'run' | 'suite' = 'run') => {
  const client = new QueryClient()
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const id = ref(kind === 'run' ? 'run-1' : 'suite-1')
  const active = ref(true)
  let api!: ReturnType<typeof useRunStream>
  const Host = defineComponent({
    setup() {
      api = kind === 'run' ? useRunStream(id, active) : useSuiteRunStream(id, active)
      return () => h('div')
    },
  })
  const wrapper = mount(Host, { global: { plugins: [[VueQueryPlugin, { queryClient: client }]] } })
  const keys = () =>
    invalidate.mock.calls.map((call) => (call[0] as { queryKey: unknown[] }).queryKey)
  return { wrapper, api, id, active, invalidate, keys }
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Run event stream', () => {
  it('opens the Run stream only while the Run is active', async () => {
    const { active, api } = setup()
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0]!.url).toMatch(/\/api\/v1\/runs\/run-1\/events$/)
    expect(api.state.value).toBe('reconnecting')
    FakeEventSource.instances[0]!.open()
    expect(api.state.value).toBe('live')

    active.value = false
    await nextTick()
    expect(FakeEventSource.instances[0]!.closed).toBe(true)
    expect(api.state.value).toBe('idle')
  })

  it.each([
    'run.paused',
    'run.resumed',
    'run.cancelled',
    'run.step.updated',
    'run.status',
    'step.status',
  ])('refreshes the whole Run and its pause on %s, debounced', (type) => {
    const { keys } = setup()
    const stream = FakeEventSource.instances[0]!
    stream.open()
    stream.emit(type)
    stream.emit(type)
    stream.emit(type)
    expect(keys()).toHaveLength(0)
    vi.advanceTimersByTime(150)
    expect(keys()).toEqual([RUN_DETAIL, RUN_PAUSE]) // once, not three times
  })

  it('refreshes from the server when the stream ends', () => {
    const { keys, api } = setup()
    const stream = FakeEventSource.instances[0]!
    stream.open()
    stream.emit('end')
    expect(keys()).toEqual([RUN_DETAIL, RUN_PAUSE])
    expect(stream.closed).toBe(true)
    expect(api.state.value).toBe('idle')
  })

  it('does a full refresh on reconnect instead of trusting missed events', () => {
    const { keys, api } = setup()
    const stream = FakeEventSource.instances[0]!
    stream.open()
    expect(keys()).toHaveLength(0) // the first connection needs no recovery

    stream.fail() // dropped; the browser retries on its own
    expect(api.state.value).toBe('reconnecting')
    stream.open() // reconnected
    expect(api.state.value).toBe('live')
    expect(keys()).toEqual([RUN_DETAIL, RUN_PAUSE])
  })

  it('falls back to polling after repeated failures', () => {
    const { api } = setup()
    const stream = FakeEventSource.instances[0]!
    for (let i = 1; i < MAX_STREAM_FAILURES; i += 1) {
      stream.fail()
      expect(api.state.value).toBe('reconnecting')
    }
    stream.fail()
    expect(api.state.value).toBe('polling')
    expect(stream.closed).toBe(true)
  })

  it('falls back to polling at once when the browser gives up on the stream', () => {
    const { api } = setup()
    FakeEventSource.instances[0]!.fail(true)
    expect(api.state.value).toBe('polling')
  })

  it('polls when EventSource is not available at all', () => {
    vi.stubGlobal('EventSource', undefined)
    const { api } = setup()
    expect(FakeEventSource.instances).toHaveLength(0)
    expect(api.state.value).toBe('polling')
  })

  it('reopens against the new Run when the id changes', async () => {
    const { id } = setup()
    id.value = 'run-2'
    await nextTick()
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(FakeEventSource.instances[0]!.closed).toBe(true)
    expect(FakeEventSource.instances[1]!.url).toMatch(/runs\/run-2\/events$/)
  })

  it('closes the stream and drops a pending refresh when the page is left', () => {
    const { wrapper, keys } = setup()
    const stream = FakeEventSource.instances[0]!
    stream.open()
    stream.emit('run.paused')
    wrapper.unmount()
    vi.advanceTimersByTime(500)
    expect(stream.closed).toBe(true)
    expect(keys()).toHaveLength(0)
  })
})

describe('Suite Run event stream', () => {
  it('follows suiteRun.updated and refreshes the whole Suite Run', () => {
    const { keys } = setup('suite')
    const stream = FakeEventSource.instances[0]!
    expect(stream.url).toMatch(/\/api\/v1\/suite-runs\/suite-1\/events$/)
    stream.open()
    stream.emit('suiteRun.updated')
    vi.advanceTimersByTime(150)
    expect(keys()).toEqual([['suite-runs', 'detail', 'suite-1']])
  })

  it('also recovers with a full refresh after a reconnect', () => {
    const { keys } = setup('suite')
    const stream = FakeEventSource.instances[0]!
    stream.open()
    stream.fail()
    stream.open()
    expect(keys()).toEqual([['suite-runs', 'detail', 'suite-1']])
  })
})
