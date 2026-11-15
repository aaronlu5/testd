import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { createMemoryHistory, createRouter } from 'vue-router'
import RunConsoleView from '~/views/platform/runs/RunConsoleView.vue'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  })

const NODES = [
  { id: 'wait', type: 'delay', name: 'Wait', parameters: { durationSeconds: 1 } },
  { id: 'inspect', type: 'breakpoint', name: 'Inspect order', parameters: { enabled: true } },
  { id: 'verify', type: 'assert', name: 'Verify status', parameters: {} },
]

const runDetail = (overrides: Record<string, unknown> = {}) => ({
  id: 'run-1',
  kind: 'test',
  status: 'Paused',
  environmentId: 'local-test',
  requestedBy: 'tester',
  requestedAt: '2026-01-01T00:00:00.000Z',
  startedAt: '2026-01-01T00:00:01.000Z',
  pausedAt: '2026-01-01T00:00:05.000Z',
  continuationGeneration: 1,
  test: { id: 't', version: 1 },
  testData: { id: 'd', version: 1 },
  variableOverrides: {},
  snapshots: {
    test: { name: 'Order flow', nodes: NODES, edges: [] },
    testData: { name: 'Data' },
    environment: { id: 'local-test', name: 'Local', classification: 'TEST', targets: [] },
  },
  stepRuns: [
    {
      id: 's-wait',
      runId: 'run-1',
      nodeId: 'wait',
      attempt: 1,
      status: 'Succeeded',
      logs: [],
      artifacts: [],
    },
    {
      id: 's-bp',
      runId: 'run-1',
      nodeId: 'inspect',
      attempt: 1,
      status: 'Paused',
      logs: [],
      artifacts: [],
    },
  ],
  lastEventSeq: 7,
  ...overrides,
})

const pauseBody = () => ({
  run: { id: 'run-1', status: 'Paused', continuationGeneration: 1 },
  pause: {
    id: 'p1',
    runId: 'run-1',
    breakpointStepRunId: 's-bp',
    breakpointNodeId: 'inspect',
    message: 'Check the payload.',
    nextNodeId: 'verify',
    nextNodeName: 'Verify status',
    nextNodeType: 'assert',
    nextResolvedInputPreview: { actual: 1, apiKey: '***REDACTED***' },
    pausedAt: '2026-01-01T00:00:05.000Z',
    continuationGeneration: 1,
  },
  completedSteps: [
    { id: 's-wait', nodeId: 'wait', attempt: 1, status: 'Succeeded', durationMs: 1000 },
  ],
  lastEventSeq: 7,
})

type State = { run: ReturnType<typeof runDetail>; resume?: () => Response; cancel?: () => Response }

const install = (state: State) => {
  const calls: { method: string; path: string; body?: unknown }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input)
      const method = init?.method ?? 'GET'
      calls.push({
        method,
        path: url.pathname,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      if (url.pathname === '/api/v1/runs/run-1' && method === 'GET') return json(state.run)
      if (url.pathname === '/api/v1/runs/run-1/pause') {
        return state.run.status === 'Paused'
          ? json(pauseBody())
          : json({ title: 'Resource not found', status: 404, code: 'VALIDATION_NOT_FOUND' }, 404)
      }
      if (url.pathname === '/api/v1/runs/run-1/resume')
        return (
          state.resume?.() ??
          json({ run: { id: 'run-1' }, continuationGeneration: 2, alreadyResumed: false }, 202)
        )
      if (url.pathname === '/api/v1/runs/run-1/cancel')
        return state.cancel?.() ?? json({ id: 'run-1' }, 202)
      return json({ title: 'Not found', status: 404 }, 404)
    }),
  )
  return calls
}

const mountConsole = async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/runs/:id', component: RunConsoleView }],
  })
  await router.push('/runs/run-1')
  await router.isReady()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = mount(RunConsoleView, {
    global: {
      plugins: [router, [VueQueryPlugin, { queryClient: client }]],
      stubs: { FlowCanvas: true, PageBreadcrumb: true, BOffcanvas: true },
    },
  })
  await flushPromises()
  return { wrapper, client }
}

afterEach(() => vi.unstubAllGlobals())

describe('Run console while paused', () => {
  it('shows the banner, the masked next input and the actions, and no plain Cancel in the header', async () => {
    install({ run: runDetail() })
    const { wrapper } = await mountConsole()

    expect(wrapper.get('[data-testid="paused-title"]').text()).toBe(
      'Paused at breakpoint “Inspect order”',
    )
    expect(wrapper.get('[data-testid="pause-message"]').text()).toBe('Check the payload.')
    expect(wrapper.get('[data-testid="next-input"]').text()).toContain('***REDACTED***')
    expect(wrapper.get('[data-testid="run-status"]').attributes('data-status')).toBe('Paused')
    // One Cancel (inside the inspector), not two competing ones.
    expect(wrapper.find('[data-testid="cancel-run"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="cancel-paused-run"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="rerun-run"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="resume-run"]').attributes('disabled')).toBeUndefined()
  })

  it('resumes with the inspected generation and refreshes the Run afterwards', async () => {
    const state: State = { run: runDetail() }
    const calls = install(state)
    const { wrapper } = await mountConsole()

    state.resume = () => {
      state.run = runDetail({ status: 'Queued', continuationGeneration: 2, pausedAt: undefined })
      return json({ run: { id: 'run-1' }, continuationGeneration: 2, alreadyResumed: false }, 202)
    }
    await wrapper.get('[data-testid="resume-run"]').trigger('click')
    await flushPromises()

    const resume = calls.find((c) => c.path.endsWith('/resume'))
    expect(resume).toMatchObject({ method: 'POST', body: { continuationGeneration: 1 } })
    // The full Run was fetched again and the inspector is gone with the Paused state.
    expect(wrapper.get('[data-testid="run-status"]').attributes('data-status')).toBe('Queued')
    expect(wrapper.find('[data-testid="breakpoint-inspector"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="paused-banner"]').exists()).toBe(false)
  })

  it('reports a stale-generation conflict and falls back to the refreshed state', async () => {
    const state: State = { run: runDetail() }
    install(state)
    const { wrapper } = await mountConsole()

    state.resume = () => {
      // Someone else resumed meanwhile; the Run has moved on.
      state.run = runDetail({ status: 'Running', continuationGeneration: 2 })
      return json(
        {
          title: 'Conflict',
          status: 409,
          code: 'EXECUTION_STALE_CONTINUATION',
          detail: 'The Run was resumed or changed since this pause was inspected.',
        },
        409,
      )
    }
    await wrapper.get('[data-testid="resume-run"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="run-status"]').attributes('data-status')).toBe('Running')
    expect(wrapper.find('[data-testid="resume-run"]').exists()).toBe(false) // no stale button left behind
    expect(wrapper.find('[data-testid="cancel-run"]').exists()).toBe(true) // normal active-Run Cancel
  })

  it('cancels a paused Run from the inspector', async () => {
    const state: State = { run: runDetail() }
    const calls = install(state)
    const { wrapper } = await mountConsole()
    state.cancel = () => {
      state.run = runDetail({ status: 'Cancelled', pausedAt: undefined })
      return json({ id: 'run-1', status: 'Cancelled' }, 202)
    }
    await wrapper.get('[data-testid="cancel-paused-run"]').trigger('click')
    await flushPromises()

    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/cancel'))).toBe(true)
    expect(wrapper.get('[data-testid="run-status"]').attributes('data-status')).toBe('Cancelled')
    expect(wrapper.find('[data-testid="breakpoint-inspector"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="rerun-run"]').exists()).toBe(true)
  })

  it('does not request the pause for a Run that is not paused', async () => {
    const calls = install({ run: runDetail({ status: 'Running', pausedAt: undefined }) })
    const { wrapper } = await mountConsole()
    expect(calls.some((c) => c.path.endsWith('/pause'))).toBe(false)
    expect(wrapper.find('[data-testid="paused-banner"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="cancel-run"]').exists()).toBe(true)
  })

  it('keeps showing a paused Run as active so it keeps refreshing', async () => {
    install({ run: runDetail() })
    const { wrapper } = await mountConsole()
    // A Paused Run is neither finished nor idle: polling/streaming continues.
    expect(wrapper.find('[data-testid="stream-polling"]').exists()).toBe(true) // jsdom has no EventSource
  })
})
