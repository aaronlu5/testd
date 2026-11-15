import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import MockApiMonitor from '~/components/platform/MockApiMonitor.vue'

afterEach(() => vi.unstubAllGlobals())

const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

type Status = {
  running: boolean
  activeRuns: number
  lastRequestId: number
  message?: string
}

const record = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  at: '2026-10-27T10:15:30.000Z',
  method: 'POST',
  path: '/payments',
  query: '?dry=1',
  requestHeaders: { 'content-type': 'application/json' },
  requestBody: '{"amount":5}',
  requestBodyTruncated: false,
  status: 201,
  matched: true,
  setupName: 'Payments',
  ruleNumber: 1,
  ruleName: 'Create',
  responseBody: '{"id":9}',
  ...over,
})

const mountMonitor = (initial: Status) => {
  const state = { status: initial, items: [] as unknown[], cleared: 0 }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(input).pathname
      if (path.endsWith('/helpers/mock-api/status'))
        return json({ baseUrl: 'http://127.0.0.1:3002', ...state.status })
      if (path.endsWith('/helpers/mock-api/requests')) {
        if (init?.method === 'DELETE') {
          state.cleared += 1
          state.items = []
          state.status = { ...state.status, lastRequestId: 0 }
          return json(null, 204)
        }
        return json({ items: state.items, total: state.items.length, lastId: 0, maxRecords: 500 })
      }
      return json({})
    }),
  )
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = mount(MockApiMonitor, {
    global: {
      plugins: [[VueQueryPlugin, { queryClient }]],
      stubs: { RouterLink: { template: '<a><slot /></a>' } },
    },
    attachTo: document.body,
  })
  return { wrapper, state, queryClient }
}

const dotState = (wrapper: ReturnType<typeof mount>) =>
  wrapper.get('[data-testid="mock-api-dot"]').attributes('data-state')

describe('Mock API monitor', () => {
  it('shows whether the server is running, idle or serving a Run', async () => {
    const down = mountMonitor({
      running: false,
      activeRuns: 0,
      lastRequestId: 0,
      message: 'The worker has stopped reporting.',
    })
    await vi.waitFor(() => expect(dotState(down.wrapper)).toBe('down'))
    expect(down.wrapper.get('[data-testid="mock-api-toggle"]').attributes('title')).toContain(
      'not running',
    )
    down.wrapper.unmount()

    const idle = mountMonitor({ running: true, activeRuns: 0, lastRequestId: 0 })
    await vi.waitFor(() => expect(dotState(idle.wrapper)).toBe('idle'))
    idle.wrapper.unmount()

    const serving = mountMonitor({ running: true, activeRuns: 1, lastRequestId: 0 })
    await vi.waitFor(() => expect(dotState(serving.wrapper)).toBe('serving'))
    expect(
      serving.wrapper.get('[data-testid="mock-api-toggle"]').attributes('aria-label'),
    ).toContain('serving a Run')
    serving.wrapper.unmount()
  })

  it('lists the requests with the response each got, and the rule that answered', async () => {
    const { wrapper, state } = mountMonitor({ running: true, activeRuns: 1, lastRequestId: 2 })
    state.items = [
      record(2, {
        path: '/missing',
        query: '',
        status: 404,
        matched: false,
        setupName: undefined,
        ruleNumber: undefined,
        ruleName: undefined,
        requestBody: undefined,
        responseBody: '{"error":"No Mock API rule matches this request."}',
      }),
      record(1),
    ]
    await vi.waitFor(() => expect(dotState(wrapper)).toBe('serving'))
    await wrapper.get('[data-testid="mock-api-toggle"]').trigger('click')

    await vi.waitFor(() =>
      expect(document.body.querySelectorAll('[data-testid="mock-api-request"]')).toHaveLength(2),
    )
    const text = document.body.querySelector('[data-testid="mock-api-requests"]')?.textContent ?? ''
    expect(text).toContain('/payments?dry=1')
    expect(text).toContain('201')
    expect(text).toContain('Answered by Payments, rule 1')
    expect(text).toContain('{"amount":5}')
    expect(text).toContain('{"id":9}')
    expect(text).toContain('/missing')
    expect(text).toContain('No rule matched')
    expect(document.body.querySelector('[data-testid="mock-api-address"]')?.textContent).toBe(
      'http://127.0.0.1:3002',
    )
    wrapper.unmount()
  })

  it('badges requests that arrive after load, and clears the log on request', async () => {
    const { wrapper, state, queryClient } = mountMonitor({
      running: true,
      activeRuns: 0,
      lastRequestId: 5,
    })
    await vi.waitFor(() => expect(dotState(wrapper)).toBe('idle'))
    expect(wrapper.find('[data-testid="mock-api-badge"]').exists()).toBe(false)

    state.status = { ...state.status, lastRequestId: 8 }
    await queryClient.invalidateQueries({ queryKey: ['mock-api', 'status'] })
    await vi.waitFor(() => expect(wrapper.get('[data-testid="mock-api-badge"]').text()).toBe('3'))

    state.items = [record(8), record(7), record(6)]
    await wrapper.get('[data-testid="mock-api-toggle"]').trigger('click')
    await vi.waitFor(() =>
      expect(document.body.querySelectorAll('[data-testid="mock-api-request"]')).toHaveLength(3),
    )
    // Opening the panel counts them as seen.
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="mock-api-badge"]').exists()).toBe(false),
    )
    ;(document.body.querySelector('[data-testid="mock-api-clear"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(state.cleared).toBe(1))
    wrapper.unmount()
  })
})
