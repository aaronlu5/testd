import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import RunLaunchView from '~/views/platform/runs/RunLaunchView.vue'
import { buildOverrides } from '~/components/platform/launch'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  })

const summary = (id: string, name: string) => ({
  id,
  type: 'test',
  name,
  tags: [],
  currentVersion: 1,
  contentHash: 'h',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

const testAsset = {
  id: 't1',
  version: 2,
  name: 'Orders',
  tags: [],
  variables: { orderId: 'ORD-1', apiKey: 'x' },
  nodes: [],
  edges: [],
}

type Handler = (url: URL, init?: RequestInit) => Response | undefined

const installFetch = (create: Handler) => {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input)
      calls.push({ url: input, init })
      const special = create(url, init)
      if (special) return special
      const path = url.pathname
      if (path === '/api/v1/tests') return json({ items: [summary('t1', 'Orders')] })
      if (path === '/api/v1/test-data') return json({ items: [summary('d1', 'Valid order')] })
      if (path === '/api/v1/environments')
        return json({
          items: [
            { id: 'local-test', name: 'Local test', classification: 'TEST', targets: [] },
            { id: 'staging', name: 'Staging', classification: 'STAGING', targets: [] },
          ],
        })
      if (path === '/api/v1/tests/t1/versions')
        return json({
          items: [
            { version: 1, contentHash: 'a', createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'x' },
            { version: 2, contentHash: 'b', createdAt: '2026-01-02T00:00:00.000Z', createdBy: 'x' },
          ],
        })
      if (path === '/api/v1/test-data/d1/versions')
        return json({
          items: [
            { version: 1, contentHash: 'a', createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'x' },
          ],
        })
      if (path === '/api/v1/tests/t1') return json(testAsset)
      return json({ title: 'Not found', status: 404 }, 404)
    }),
  )
  return calls
}

const mountLauncher = async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/runs/new', component: RunLaunchView },
      { path: '/runs/:id', component: { template: '<div data-testid="console" />' } },
      { path: '/runs', component: { template: '<div />' } },
      { path: '/', component: { template: '<div />' } },
    ],
  })
  await router.push('/runs/new?testId=t1&dataSetId=d1')
  await router.isReady()
  const wrapper = mount(RunLaunchView, {
    global: {
      plugins: [
        router,
        createPinia(),
        [
          VueQueryPlugin,
          {
            queryClient: new QueryClient({
              defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
            }),
          },
        ],
      ],
    },
  })
  await vi.waitFor(() => expect(wrapper.find('form').exists()).toBe(true))
  await flushPromises()
  return { wrapper, router }
}

afterEach(() => vi.unstubAllGlobals())

describe('Run launcher', () => {
  it('asks for the missing selections before calling the API', async () => {
    const calls = installFetch(() => undefined)
    const { wrapper } = await mountLauncher()
    expect(wrapper.find('[data-testid="launch-missing"]').exists()).toBe(false)

    await wrapper.get('form').trigger('submit')
    expect(wrapper.get('[data-testid="launch-missing"]').text()).toContain('an Environment')
    expect(calls.some((call) => call.init?.method === 'POST')).toBe(false)
  })

  it('submits the chosen versions, Environment and non-secret overrides', async () => {
    let body: Record<string, unknown> = {}
    installFetch((url, init) => {
      if (url.pathname === '/api/v1/runs' && init?.method === 'POST') {
        body = JSON.parse(String(init.body))
        return json({ id: 'run-1', status: 'Queued' }, 202)
      }
      return undefined
    })
    const { wrapper, router } = await mountLauncher()

    await wrapper.get('#run-test-version').setValue('1')
    await wrapper.get('#run-env').setValue('local-test')
    await vi.waitFor(() => expect(wrapper.find('#override-orderId').exists()).toBe(true))
    await wrapper.get('#override-orderId').setValue('ORD-9')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(body).toEqual({
      testId: 't1',
      testVersion: 1,
      dataSetId: 'd1',
      environmentId: 'local-test',
      variableOverrides: { orderId: 'ORD-9' },
    })
    expect(router.currentRoute.value.path).toBe('/runs/run-1')
  })

  it('shows server validation issues clearly and stays on the page', async () => {
    installFetch((url, init) => {
      if (url.pathname === '/api/v1/runs' && init?.method === 'POST') {
        return json(
          {
            type: 'https://test-platform.dev/problems/validation-expression',
            title: 'Validation failed',
            status: 422,
            code: 'VALIDATION_EXPRESSION',
            detail: 'The Test cannot be run because it is not valid.',
            errors: [
              {
                path: '/nodes/1/parameters/actual',
                message: 'Step "later" does not precede this Step.',
              },
            ],
          },
          422,
        )
      }
      return undefined
    })
    const { wrapper, router } = await mountLauncher()
    await wrapper.get('#run-env').setValue('local-test')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    const alert = wrapper.get('[data-testid="problem-alert"]')
    expect(alert.text()).toContain('The Test cannot be run because it is not valid.')
    expect(alert.text()).toContain('nodes › 1 › parameters › actual')
    expect(alert.text()).toContain('does not precede this Step')
    expect(alert.text()).toContain('VALIDATION_EXPRESSION')
    expect(router.currentRoute.value.path).toBe('/runs/new')
  })

  it('refuses secret-looking override names without sending them', async () => {
    const calls = installFetch(() => undefined)
    const { wrapper } = await mountLauncher()
    await wrapper.get('#run-env').setValue('local-test')
    await vi.waitFor(() => expect(wrapper.find('#override-apiKey').exists()).toBe(true))
    await wrapper.get('#override-apiKey').setValue('hunter2')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.text()).toContain('Secrets cannot be passed as overrides.')
    expect(calls.some((call) => call.init?.method === 'POST')).toBe(false)
  })

  it('shows a retryable message when the API cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: RunLaunchView }],
    })
    await router.push('/')
    const wrapper = mount(RunLaunchView, {
      global: {
        plugins: [
          router,
          createPinia(),
          [
            VueQueryPlugin,
            { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
          ],
        ],
      },
    })
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="problem-alert"]').exists()).toBe(true),
    )
    expect(wrapper.text()).toContain('Cannot reach the API')
  })
})

describe('buildOverrides', () => {
  it('skips blanks, parses JSON, keeps plain text, and flags secret names', () => {
    const result = buildOverrides(['a', 'b', 'c', 'password', 'unused'], {
      a: '5',
      b: 'hello',
      c: '  ',
      password: 'x',
    })
    expect(result.value).toEqual({ a: 5, b: 'hello' })
    expect(result.errors).toEqual({ password: 'Secrets cannot be passed as overrides.' })
  })
})
