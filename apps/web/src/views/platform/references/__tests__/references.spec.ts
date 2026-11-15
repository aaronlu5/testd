import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { VueQueryPlugin } from '@tanstack/vue-query'
import ReferencesView from '~/views/platform/references/index.vue'

const items = [
  {
    name: 'runNumber',
    scope: 'run',
    type: 'number',
    description: 'Counts the Runs of this Test.',
    example: '42',
  },
  {
    name: 'testId',
    scope: 'test',
    type: 'text',
    description: 'A short id that belongs to the Test.',
    example: 't-4f9ac2e81b',
  },
]

afterEach(() => vi.unstubAllGlobals())

describe('References page', () => {
  it('lists every global variable with its description and example, grouped by scope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ items }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    const wrapper = mount(ReferencesView, { global: { plugins: [VueQueryPlugin] } })
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="global-runNumber"]').exists()).toBe(true),
    )

    const run = wrapper.get('[data-testid="global-runNumber"]').text()
    expect(run).toContain('{{ global.runNumber }}')
    expect(run).toContain('Counts the Runs of this Test.')
    expect(run).toContain('42')
    expect(wrapper.get('[data-testid="global-testId"]').text()).toContain('t-4f9ac2e81b')
    expect(wrapper.text()).toContain('Per Run')
    expect(wrapper.text()).toContain('Per Test')
    expect(wrapper.text()).not.toContain('Per Environment')
    expect(wrapper.find('[data-testid="reference-examples"]').text()).toContain(
      'ORD-{{ global.runNumber }}-{{ global.runSeed }}',
    )
  })
})
