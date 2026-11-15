import type { CreateSuiteRunInput } from '~/api/platform'
import type { EnvironmentSummary } from '~/api/types'

export type ConcurrencyBounds = {
  min: 1
  /** The Environment's limit as reported by the API; 1 when none is configured. */
  max: number
  /** The control is only useful when more than one item may run at once. */
  editable: boolean
}

/**
 * The concurrency the API will accept for an Environment. The limit itself comes from the API
 * (`suiteConcurrencyLimit`); the browser only reflects it and the server remains the authority.
 */
export const concurrencyBounds = (
  environment: EnvironmentSummary | undefined,
): ConcurrencyBounds => {
  const max = Math.max(1, environment?.suiteConcurrencyLimit ?? 1)
  return { min: 1, max, editable: max > 1 }
}

export type SuiteRunRequest = { body: CreateSuiteRunInput } | { error: string }

/** Builds the request; blank concurrency means "use the Suite's default, capped by the Environment". */
export const buildSuiteRunRequest = (input: {
  suiteId: string
  environment: EnvironmentSummary | undefined
  concurrencyText: string
}): SuiteRunRequest => {
  if (!input.suiteId) return { error: 'Select a Suite.' }
  if (!input.environment) return { error: 'Select an Environment.' }
  const bounds = concurrencyBounds(input.environment)
  const body: CreateSuiteRunInput = {
    suiteId: input.suiteId,
    environmentId: input.environment.id,
  }
  const text = input.concurrencyText.trim()
  if (text !== '') {
    const value = Number(text)
    if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
      return {
        error: `Concurrency must be a whole number from ${bounds.min} to ${bounds.max} for this Environment.`,
      }
    }
    body.maxConcurrency = value
  }
  return { body }
}
