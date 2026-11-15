import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { ApiError } from '~/api/client'
import PausedRunBanner from '~/components/platform/PausedRunBanner.vue'
import ProblemAlert from '~/components/platform/ProblemAlert.vue'
import StatusBadge from '~/components/platform/StatusBadge.vue'
import { describeError, describeIssuePath } from '~/components/platform/problem'

const pause = { pausedAt: '2026-10-27T10:15:30.000Z' }

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
    const wrapper = mount(ProblemAlert, { props: { error: validation } })
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
    const wrapper = mount(ProblemAlert, { props: { error: undefined } })
    expect(wrapper.find('[data-testid="problem-alert"]').exists()).toBe(false)
  })

  it('describes the root of the Test and escaped path parts', () => {
    expect(describeIssuePath('')).toBe('Test')
    expect(describeIssuePath('/variables/a~1b')).toBe('variables › a/b')
  })
})

describe('paused run presentation', () => {
  it('renders the prominent banner for the paused node', () => {
    const wrapper = mount(PausedRunBanner, {
      props: {
        breakpointName: 'Inspect order',
        nextName: 'Verify status',
        pausedAt: pause.pausedAt,
      },
    })
    expect(wrapper.get('[data-testid="paused-title"]').text()).toBe(
      'Paused at breakpoint “Inspect order”',
    )
    expect(wrapper.text()).toContain('Verify status')
    expect(wrapper.text()).toContain('It has not started')
    expect(wrapper.get('[data-testid="paused-banner"]').attributes('role')).toBe('status')
    const end = mount(PausedRunBanner, { props: { breakpointName: 'End' } })
    expect(end.text()).toContain('No Step follows')
  })

  it('shows Paused as a distinct, text-labelled state', () => {
    const paused = mount(StatusBadge, { props: { status: 'Paused' } })
    const running = mount(StatusBadge, { props: { status: 'Running' } })
    expect(paused.text()).toBe('Paused')
    expect(paused.classes().join(' ')).not.toBe(running.classes().join(' '))
    expect(mount(StatusBadge, { props: { status: 'WaitingForBreakpoint' } }).text()).toBe(
      'Waiting For Breakpoint',
    )
  })
})
