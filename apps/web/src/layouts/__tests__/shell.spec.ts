import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { createMemoryHistory, createRouter } from 'vue-router'
import DefaultLayout from '../DefaultLayout.vue'
import { allNavItems, isNavActive, navGroups } from '../nav'

afterEach(() => vi.unstubAllGlobals())

async function mountShell(path = '/tests') {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  )
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'platform.home', component: { template: '<p>home</p>' } },
      { path: '/tests', name: 'platform.tests', component: { template: '<p>tests</p>' } },
      { path: '/tests/new', name: 'platform.tests.new', component: { template: '<p>new</p>' } },
    ],
  })
  await router.push(path)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const wrapper = mount(DefaultLayout, {
    global: {
      plugins: [
        createPinia(),
        router,
        [
          VueQueryPlugin,
          { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        ],
      ],
    },
  })
  return { wrapper, warn }
}

describe('app shell', () => {
  it('renders the top bar widgets and the menu without unresolved components', async () => {
    const { wrapper, warn } = await mountShell()
    for (const id of [
      'top-bar',
      'side-nav',
      'quick-search',
      'environment-indicator',
      'mock-api-toggle',
      'inspector-toggle',
      'theme-menu',
      'fullscreen-toggle',
      'user-menu',
    ]) {
      expect(wrapper.find(`[data-testid="${id}"]`).exists(), id).toBe(true)
    }
    const unresolved = warn.mock.calls.filter((call) =>
      String(call[0]).includes('resolve component'),
    )
    expect(unresolved).toEqual([])
    wrapper.unmount()
  })

  it('marks the current page and keeps it highlighted on child routes', async () => {
    const { wrapper } = await mountShell('/tests/new')
    const current = wrapper.findAll('[aria-current="page"]')
    expect(current).toHaveLength(1)
    expect(current[0]!.text()).toBe('Tests')
    wrapper.unmount()
  })
})

describe('navigation data', () => {
  it('keeps the original groups and eleven links', () => {
    expect(navGroups.map((g) => g.label)).toEqual(['Test Platform', 'Helpers', 'Configuration'])
    expect(allNavItems.map((i) => i.to)).toEqual([
      '/',
      '/tests',
      '/test-data',
      '/suites',
      '/suite-runs',
      '/runs',
      '/references',
      '/system/health',
      '/mock-api',
      '/environments',
      '/secrets',
    ])
  })

  it('does not confuse similarly named routes', () => {
    const runs = allNavItems.find((i) => i.to === '/runs')!
    const suiteRuns = allNavItems.find((i) => i.to === '/suite-runs')!
    expect(isNavActive(runs, 'platform.suite-runs')).toBe(false)
    expect(isNavActive(suiteRuns, 'platform.suite-runs.detail')).toBe(true)
    expect(isNavActive(allNavItems.find((i) => i.to === '/tests')!, 'platform.test-data')).toBe(
      false,
    )
  })
})
