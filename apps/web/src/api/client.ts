import type { ValidationIssue } from '~/api/types'

export type ProblemDetails = {
  type?: string
  title?: string
  status?: number
  detail?: string
  instance?: string
  code?: string
  errors?: ValidationIssue[]
  [extension: string]: unknown
}

export type ApiErrorKind = 'problem' | 'http' | 'network' | 'timeout' | 'invalid-response'

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status?: number
  readonly problem?: ProblemDetails
  readonly requestId: string

  constructor(init: {
    kind: ApiErrorKind
    message: string
    requestId: string
    status?: number
    problem?: ProblemDetails
  }) {
    super(init.message)
    this.name = 'ApiError'
    this.kind = init.kind
    this.status = init.status
    this.problem = init.problem
    this.requestId = init.requestId
  }
}

export const REQUEST_ID_HEADER = 'X-Request-Id'
const DEFAULT_API_BASE_URL = 'http://127.0.0.1:3000'
const DEFAULT_TIMEOUT_MS = 10_000

export const getApiBaseUrl = (): string => {
  const configured = import.meta.env.VITE_API_BASE_URL?.trim()
  return (configured || DEFAULT_API_BASE_URL).replace(/\/+$/, '')
}

export const createRequestId = (): string => crypto.randomUUID()

const isProblemDetails = (value: unknown): value is ProblemDetails =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export type ApiRequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
  timeoutMs?: number
  /** Receives a successful response, for headers such as `X-Platform-Warnings`. */
  onResponse?: (response: Response) => void
}

/** Sends a credential-free JSON request and maps failures to `ApiError`. */
export const apiRequest = async <T>(path: string, options: ApiRequestOptions = {}): Promise<T> => {
  const requestId = createRequestId()
  const headers: Record<string, string> = {
    Accept: 'application/json, application/problem+json',
    [REQUEST_ID_HEADER]: requestId,
  }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'

  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout

  let response: Response
  try {
    response = await fetch(`${getApiBaseUrl()}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'omit',
      signal,
    })
  } catch (err) {
    if (options.signal?.aborted) throw err
    const timedOut = timeout.aborted
    throw new ApiError({
      kind: timedOut ? 'timeout' : 'network',
      message: timedOut ? 'The API did not respond in time.' : 'The API is unreachable.',
      requestId,
    })
  }

  const text = await response.text()
  if (response.ok) options.onResponse?.(response)
  let payload: unknown
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = undefined
    }
  }

  if (!response.ok) {
    const problem = isProblemDetails(payload) ? payload : undefined
    throw new ApiError({
      kind: problem ? 'problem' : 'http',
      message:
        problem?.detail ?? problem?.title ?? `Request failed with status ${response.status}.`,
      requestId,
      status: response.status,
      problem,
    })
  }

  if (text && payload === undefined) {
    throw new ApiError({
      kind: 'invalid-response',
      message: 'The API returned a non-JSON response.',
      requestId,
      status: response.status,
    })
  }

  return payload as T
}

/** Field-level issues carried by a validation problem, or an empty list. */
export const problemIssues = (error: unknown): ValidationIssue[] => {
  if (!(error instanceof ApiError)) return []
  const issues = error.problem?.errors
  return Array.isArray(issues) ? issues : []
}
