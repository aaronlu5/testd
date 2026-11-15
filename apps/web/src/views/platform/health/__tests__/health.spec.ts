import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { VueQueryPlugin } from '@tanstack/vue-query'
import HealthView from '~/views/platform/health/index.vue'

const stubs = { RouterLink: { template: '<a><slot /></a>' } }

const mountView = () => mount(HealthView, { global: { plugins: [VueQueryPlugin], stubs } })

afterEach(() => vi.unstubAllGlobals())

describe('API status view', () => {
  it('shows a graceful message when the API is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))

    const wrapper = mountView()
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="api-unavailable"]').exists()).toBe(true),
    )

    expect(wrapper.text()).toContain('API unavailable')
    expect(wrapper.text()).toContain('The API is unreachable.')
  })

  it('shows readiness when the API responds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: 'ready' }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )

    const wrapper = mountView()
    await vi.waitFor(() => expect(wrapper.find('[data-testid="api-ready"]').exists()).toBe(true))
    await flushPromises()

    expect(wrapper.text()).toContain('API ready')
  })
})
