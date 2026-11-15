import { describe, expect, it } from 'vitest'
import type { EnvironmentSummary } from '~/api/types'
import { buildSuiteRunRequest, concurrencyBounds } from '~/components/platform/suite-launch'

const env = (suiteConcurrencyLimit: number, id = 'local-test'): EnvironmentSummary => ({
  id,
  name: id,
  classification: 'TEST',
  suiteConcurrencyLimit,
  targets: [],
})

describe('Suite concurrency bounds', () => {
  it('follow the limit reported by the API and default to sequential', () => {
    expect(concurrencyBounds(env(1))).toEqual({ min: 1, max: 1, editable: false })
    expect(concurrencyBounds(env(4))).toEqual({ min: 1, max: 4, editable: true })
    expect(concurrencyBounds(undefined)).toEqual({ min: 1, max: 1, editable: false })
    expect(concurrencyBounds({ ...env(1), suiteConcurrencyLimit: 0 })).toMatchObject({ max: 1 })
  })
})

describe('Suite Run request', () => {
  it('requires a Suite and an Environment', () => {
    expect(buildSuiteRunRequest({ suiteId: '', environment: env(1), concurrencyText: '' })).toEqual(
      {
        error: 'Select a Suite.',
      },
    )
    expect(
      buildSuiteRunRequest({ suiteId: 's1', environment: undefined, concurrencyText: '' }),
    ).toEqual({ error: 'Select an Environment.' })
  })

  it('leaves concurrency out when blank, so the Suite default applies', () => {
    expect(
      buildSuiteRunRequest({ suiteId: 's1', environment: env(3), concurrencyText: ' ' }),
    ).toEqual({
      body: { suiteId: 's1', environmentId: 'local-test' },
    })
  })

  it('sends an explicit concurrency within the Environment limit', () => {
    expect(
      buildSuiteRunRequest({ suiteId: 's1', environment: env(3), concurrencyText: '2' }),
    ).toEqual({
      body: { suiteId: 's1', environmentId: 'local-test', maxConcurrency: 2 },
    })
    expect(
      buildSuiteRunRequest({ suiteId: 's1', environment: env(3), concurrencyText: '3' }),
    ).toMatchObject({
      body: { maxConcurrency: 3 },
    })
  })

  it.each(['0', '4', '-1', '1.5', 'many'])(
    'refuses %s for a limit of 3 before calling the API',
    (text) => {
      const result = buildSuiteRunRequest({
        suiteId: 's1',
        environment: env(3),
        concurrencyText: text,
      })
      expect(result).toEqual({
        error: 'Concurrency must be a whole number from 1 to 3 for this Environment.',
      })
    },
  )

  it('refuses any concurrency above 1 when the Environment is sequential', () => {
    expect(
      buildSuiteRunRequest({ suiteId: 's1', environment: env(1), concurrencyText: '2' }),
    ).toHaveProperty('error')
  })
})
