import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiRequest, REQUEST_ID_HEADER } from '~/api/client'

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' }, ...init })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('apiRequest', () => {
  it('sends a request id, omits credentials, and uses the configured base URL', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://api.test/')
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: 'ok' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(apiRequest('/health/ready')).resolves.toEqual({ status: 'ok' })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(url).toBe('http://api.test/health/ready')
    expect(init.credentials).toBe('omit')
    expect(headers[REQUEST_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/)
    expect(headers).not.toHaveProperty('Authorization')
  })

  it('maps RFC 7807 problem details to ApiError', async () => {
    const problem = {
      type: 'about:blank',
      title: 'Validation failed',
      status: 422,
      detail: 'name is required',
      code: 'VALIDATION_REQUIRED',
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(problem, { status: 422 })))

    const error = await apiRequest('/api/v1/tests').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      kind: 'problem',
      status: 422,
      message: 'name is required',
      problem,
    })
    expect((error as ApiError).requestId).toBeTruthy()
  })

  it('reports non-problem HTTP failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 502 })))

    await expect(apiRequest('/x')).rejects.toMatchObject({ kind: 'http', status: 502 })
  })

  it('reports network failures without leaking the cause as the message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))

    await expect(apiRequest('/x')).rejects.toMatchObject({
      kind: 'network',
      message: 'The API is unreachable.',
    })
  })
})
