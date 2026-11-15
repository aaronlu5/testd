import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import MockApiHelper from '~/components/platform/MockApiHelper.vue'
import {
  blankRule,
  firstMatch,
  fromRule,
  hasRuleIssues,
  requestParts,
  ruleIssues,
  toRule,
  type RuleDraft,
} from '~/components/platform/mock-setup'

const rule = (patch: Partial<RuleDraft>): RuleDraft => ({ ...blankRule(), ...patch })

describe('mock rule drafts', () => {
  it('flags a path that is not usable and a status or body that is not valid', () => {
    expect(ruleIssues(rule({ path: 'orders' })).path).toContain('start with')
    expect(ruleIssues(rule({ path: '/orders/(' })).path).toContain('regular expression')
    expect(ruleIssues(rule({ status: '99' })).status).toBeDefined()
    expect(ruleIssues(rule({ status: 'ok' })).status).toBeDefined()
    expect(ruleIssues(rule({ bodyText: '{oops' })).body).toBeDefined()
    expect(hasRuleIssues(rule({ path: '/orders/[0-9]+', status: '200', bodyText: '' }))).toBe(false)
  })

  it('round-trips a rule, leaving out what is blank', () => {
    const saved = toRule(
      rule({
        name: ' Look up ',
        method: 'GET',
        path: '/p/[0-9]+',
        status: '201',
        bodyText: '{"a":1}',
      }),
    )
    expect(saved).toEqual({
      name: 'Look up',
      method: 'GET',
      path: '/p/[0-9]+',
      status: 201,
      body: { a: 1 },
    })
    expect(toRule(fromRule(saved))).toEqual(saved)
    expect(toRule(rule({ path: '/x', status: '204', bodyText: '' }))).toEqual({
      path: '/x',
      status: 204,
    })
  })

  it('finds the first matching rule the way the server does', () => {
    const rules = [
      rule({ method: 'GET', path: '/orders/[0-9]+' }),
      rule({ path: '/orders' }),
      rule({ path: '/files/.*' }),
    ]
    expect(firstMatch(rules, 'GET', '/orders/42')).toBe(0)
    expect(firstMatch(rules, 'POST', '/orders/42')).toBe(-1)
    expect(firstMatch(rules, 'post', '/orders')).toBe(1)
    expect(firstMatch(rules, 'GET', '/files/a/b/c')).toBe(2)
    expect(firstMatch(rules, 'GET', '/orders/42/lines')).toBe(-1)
    expect(requestParts('/orders/42?expand=all')).toEqual({
      path: '/orders/42',
      query: 'expand=all',
    })
    const filtered = [rule({ path: "/v1/Service?$filter=LocationId eq '[0-9]+'" })]
    expect(firstMatch(filtered, 'GET', '/v1/Service', "$filter=LocationId eq '0000023568'")).toBe(0)
    expect(firstMatch(filtered, 'GET', '/v1/Service', '$filter=LocationId%20eq%20%270001%27')).toBe(
      0,
    )
    expect(firstMatch(filtered, 'GET', '/v1/Service', '$filter=Other')).toBe(-1)
    expect(firstMatch(filtered, 'GET', '/v1/Service')).toBe(-1)
  })
})

describe('Mock API helper picker', () => {
  afterEach(() => vi.unstubAllGlobals())

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })

  const mountPicker = (modelValue: string[]) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const path = new URL(input).pathname
        if (path.endsWith('/helpers/mock-api'))
          return json({
            baseUrl: 'http://127.0.0.1:3002',
            host: '127.0.0.1:3002',
            hostname: '127.0.0.1',
            port: '3002',
          })
        return json({
          items: [
            {
              id: 'a',
              type: 'mock-setup',
              name: 'Payments',
              tags: [],
              currentVersion: 1,
              contentHash: 'h',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
            {
              id: 'b',
              type: 'mock-setup',
              name: 'Shipping',
              tags: [],
              currentVersion: 1,
              contentHash: 'h',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        })
      }),
    )
    return mount(MockApiHelper, {
      props: { modelValue, level: 'Test' },
      global: {
        plugins: [
          [
            VueQueryPlugin,
            { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
          ],
        ],
        stubs: { RouterLink: { template: '<a><slot /></a>' } },
      },
    })
  }

  it('lists the setups, shows the server host, and emits the chosen ids', async () => {
    const wrapper = mountPicker(['a'])
    await vi.waitFor(() => expect(wrapper.find('[data-testid="mock-setup-a"]').exists()).toBe(true))
    expect(wrapper.text()).toContain('Payments')
    expect(wrapper.text()).toContain('127.0.0.1:3002')
    expect((wrapper.get('[data-testid="mock-setup-a"]').element as HTMLInputElement).checked).toBe(
      true,
    )

    await wrapper.get('[data-testid="mock-setup-b"]').setValue(true)
    expect(wrapper.emitted('update:modelValue')?.[0]?.[0]).toEqual(['a', 'b'])
    await wrapper.get('[data-testid="mock-setup-a"]').setValue(false)
    expect(wrapper.emitted('update:modelValue')?.[1]?.[0]).toEqual([])
  })

  it('offers to drop a selected setup that no longer exists', async () => {
    const wrapper = mountPicker(['gone'])
    await vi.waitFor(() => expect(wrapper.text()).toContain('no longer exists'))
    await wrapper.get('#mock-missing-gone').setValue(false)
    expect(wrapper.emitted('update:modelValue')?.[0]?.[0]).toEqual([])
  })
})
