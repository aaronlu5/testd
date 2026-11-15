import { ApiError } from '~/api/client'
import type { ValidationIssue } from '~/api/types'

export type ErrorView = {
  title: string
  detail: string
  code?: string
  status?: number
  issues: ValidationIssue[]
  requestId?: string
  /** Connection problems are retryable and not the user's input. */
  connection: boolean
  variant: 'danger' | 'warning'
}

/** Turns any thrown value into something the UI can render without leaking internals. */
export const describeError = (error: unknown): ErrorView => {
  if (!(error instanceof ApiError)) {
    return {
      title: 'Something went wrong',
      detail: 'An unexpected error occurred.',
      issues: [],
      connection: false,
      variant: 'danger',
    }
  }
  if (error.kind === 'network' || error.kind === 'timeout') {
    return {
      title: error.kind === 'timeout' ? 'The API is not responding' : 'Cannot reach the API',
      detail: `${error.message} Check that the API is running, then try again.`,
      issues: [],
      requestId: error.requestId,
      connection: true,
      variant: 'warning',
    }
  }
  const problem = error.problem
  const issues = Array.isArray(problem?.errors) ? problem.errors : []
  return {
    title: problem?.title ?? 'Request failed',
    detail: problem?.detail ?? error.message,
    code: typeof problem?.code === 'string' ? problem.code : undefined,
    status: error.status,
    issues,
    requestId: error.requestId,
    connection: false,
    variant: error.status !== undefined && error.status >= 500 ? 'danger' : 'warning',
  }
}

/** `/nodes/1/parameters/expected` becomes a readable location. */
export const describeIssuePath = (path: string): string => {
  if (!path) return 'Test'
  return path
    .split('/')
    .filter(Boolean)
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .join(' › ')
}
