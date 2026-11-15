import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { ApiError } from '~/api/client'
import type { StepRun } from '~/api/types'
import ProblemAlert from '~/components/platform/ProblemAlert.vue'
import StepRunDetail from '~/components/platform/StepRunDetail.vue'
import { describeError, describeIssuePath } from '~/components/platform/problem'

const plugins: never[] = []

describe('problem details rendering', () => {
  const validation = new ApiError({
    kind: 'problem',
    message: 'The Test is not valid.',
    requestId: 'req-123',
    status: 422,
    problem: {
      type: 'https://test-platform.dev/problems/validation-schema',
      title: 'Validation failed',
      status: 422,
      detail: 'The Test is not valid and was not saved.',
      code: 'VALIDATION_SCHEMA',
      errors: [
        { path: '/nodes/0/parameters/expected', message: 'is required' },
        { path: '', message: 'must have a name' },
      ],
    },
  })

  it('renders title, detail, code, status, request id and every field issue', () => {
    const wrapper = mount(ProblemAlert, { props: { error: validation }, global: { plugins } })
    expect(wrapper.get('[data-testid="problem-title"]').text()).toBe('Validation failed')
    expect(wrapper.get('[data-testid="problem-detail"]').text()).toContain('was not saved')
    const text = wrapper.text()
    expect(text).toContain('VALIDATION_SCHEMA')
    expect(text).toContain('HTTP 422')
    expect(text).toContain('req-123')
    const issues = wrapper.findAll('[data-testid="problem-issues"] li')
    expect(issues).toHaveLength(2)
    expect(issues[0]?.text()).toContain('nodes › 0 › parameters › expected')
    expect(issues[0]?.text()).toContain('is required')
  })

  it('treats a connection failure as retryable and offers to try again', async () => {
    const offline = new ApiError({
      kind: 'network',
      message: 'The API is unreachable.',
      requestId: 'req-9',
    })
    const wrapper = mount(ProblemAlert, {
      props: { error: offline, retryable: true },
      global: { plugins },
    })
    expect(wrapper.text()).toContain('Cannot reach the API')
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('does not leak details of unexpected errors', () => {
    const view = describeError(new Error('stack trace with /etc/passwd'))
    expect(view.detail).toBe('An unexpected error occurred.')
    expect(view.detail).not.toContain('passwd')
  })

  it('renders nothing when there is no error', () => {
    const wrapper = mount(ProblemAlert, { props: { error: undefined }, global: { plugins } })
    expect(wrapper.find('[data-testid="problem-alert"]').exists()).toBe(false)
  })

  it('describes the root of the Test and escaped path parts', () => {
    expect(describeIssuePath('')).toBe('Test')
    expect(describeIssuePath('/variables/a~1b')).toBe('variables › a/b')
  })
})

describe('masked Run rendering', () => {
  const base: StepRun = {
    id: 's1',
    runId: 'r1',
    nodeId: 'call',
    attempt: 2,
    status: 'Failed',
    resolvedInput: { target: 'orders', headers: { Authorization: '***REDACTED***' } },
    outputPreview: { token: '***REDACTED***', ok: false },
    error: {
      code: 'TARGET_REQUEST',
      message: 'The target rejected the request.',
      detail: 'Credential ***REDACTED*** was refused',
      correlationIds: { 'x-request-id': 'abc' },
    },
    logs: [
      { timestamp: '2026-01-01T00:00:00.000Z', level: 'info', message: 'Sending ***REDACTED***' },
      { timestamp: '2026-01-01T00:00:01.000Z', level: 'error', message: 'Failed', data: { a: 1 } },
    ],
    artifacts: [{ id: 'art-1', contentType: 'text/plain', sizeBytes: 12, label: 'response' }],
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 1250,
  }

  it('shows masked input, output, logs and errors exactly as the API returned them', () => {
    const wrapper = mount(StepRunDetail, { props: { stepRun: base }, global: { plugins } })
    expect(wrapper.get('[data-testid="step-input"]').text()).toContain('***REDACTED***')
    expect(wrapper.get('[data-testid="step-output"]').text()).toContain('***REDACTED***')
    expect(wrapper.get('[data-testid="step-logs"]').text()).toContain('Sending ***REDACTED***')
    expect(wrapper.text()).not.toMatch(/super-secret|hunter2/)
  })

  it('classifies the failure, shows attempt, duration and correlation ids', () => {
    const wrapper = mount(StepRunDetail, { props: { stepRun: base }, global: { plugins } })
    const error = wrapper.get('[data-testid="step-error"]')
    expect(error.text()).toContain('Target call')
    expect(error.text()).toContain('TARGET_REQUEST')
    expect(error.text()).toContain('x-request-id: abc')
    expect(wrapper.text()).toContain('Attempt 2')
    expect(wrapper.text()).toContain('1.25 s')
  })

  it('links artifacts to the API without embedding their content', () => {
    const wrapper = mount(StepRunDetail, { props: { stepRun: base }, global: { plugins } })
    const link = wrapper.get('[data-testid="step-artifacts"] a')
    expect(link.attributes('href')).toMatch(/\/api\/v1\/artifacts\/art-1$/)
    expect(link.attributes('rel')).toContain('noopener')
    expect(link.text()).toBe('response')
  })

  it('explains a truncated output and links the full copy', () => {
    const stepRun: StepRun = {
      ...base,
      status: 'Succeeded',
      error: undefined,
      outputPreview: { $truncated: true, sizeBytes: 5000, preview: '{"text":"xxxx' },
      artifacts: [
        { id: 'full-1', contentType: 'application/json', sizeBytes: 5000, label: 'step-output' },
      ],
    }
    const wrapper = mount(StepRunDetail, { props: { stepRun }, global: { plugins } })
    const notice = wrapper.get('[data-testid="output-truncated"]')
    expect(notice.text()).toContain('5000 bytes')
    expect(notice.get('a').attributes('href')).toMatch(/full-1$/)
    expect(wrapper.get('[data-testid="step-output"]').text()).toBe('{"text":"xxxx')
  })

  it('handles an attempt with no output, logs or artifacts', () => {
    const stepRun: StepRun = {
      ...base,
      status: 'Cancelled',
      error: undefined,
      resolvedInput: undefined,
      outputPreview: undefined,
      logs: [],
      artifacts: [],
    }
    const wrapper = mount(StepRunDetail, { props: { stepRun }, global: { plugins } })
    expect(wrapper.text()).toContain('No input was recorded.')
    expect(wrapper.text()).toContain('This attempt produced no output.')
    expect(wrapper.text()).toContain('No log entries.')
    expect(wrapper.text()).toContain('No artifacts.')
  })
})
