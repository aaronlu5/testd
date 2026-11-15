import { describe, expect, it } from 'vitest'
import { mount, RouterLinkStub } from '@vue/test-utils'
import type {
  PausedStepSummary,
  RunPause,
  StepTypeMetadata,
  SuiteRunItemView,
  TestNode,
} from '~/api/types'
import BreakpointInspector from '~/components/platform/BreakpointInspector.vue'
import PausedRunBanner from '~/components/platform/PausedRunBanner.vue'
import SequenceConversion from '~/components/platform/SequenceConversion.vue'
import StatusBadge from '~/components/platform/StatusBadge.vue'
import StepInspector from '~/components/platform/StepInspector.vue'
import StepOrderList from '~/components/platform/StepOrderList.vue'
import SuiteRunSummary from '~/components/platform/SuiteRunSummary.vue'

const global = { stubs: { RouterLink: RouterLinkStub } }

// ---- keyboard reorder ---------------------------------------------------------------------------
describe('Step order list (keyboard and button reorder)', () => {
  const items = [
    { id: 'a', name: 'Upload order' },
    { id: 'b', name: 'Verify status' },
    { id: 'c', name: 'Assert result' },
  ]
  const make = (props: Record<string, unknown> = {}) =>
    mount(StepOrderList, { props: { items, movable: true, ...props } as never, global })

  it('offers labelled earlier/later commands that report the move', async () => {
    const wrapper = make()
    await wrapper.get('[aria-label="Move Verify status earlier, from position 2"]').trigger('click')
    await wrapper.get('[aria-label="Move Verify status later, from position 2"]').trigger('click')
    expect(wrapper.emitted('move')).toEqual([
      ['b', -1],
      ['b', 1],
    ])
  })

  it('disables moving past either end', () => {
    const wrapper = make()
    expect(
      wrapper
        .get('[aria-label="Move Upload order earlier, from position 1"]')
        .attributes('disabled'),
    ).toBeDefined()
    expect(
      wrapper
        .get('[aria-label="Move Assert result later, from position 3"]')
        .attributes('disabled'),
    ).toBeDefined()
    expect(
      wrapper
        .get('[aria-label="Move Verify status later, from position 2"]')
        .attributes('disabled'),
    ).toBeUndefined()
  })

  it('moves the focused Step with Alt+ArrowUp / Alt+ArrowDown', async () => {
    const wrapper = make()
    const verify = wrapper.get('[data-testid="step-item-b"] [data-testid="step-select"]')
    expect(verify.attributes('aria-keyshortcuts')).toBe('Alt+ArrowUp Alt+ArrowDown')
    await verify.trigger('keydown', { key: 'ArrowUp', altKey: true })
    await verify.trigger('keydown', { key: 'ArrowDown', altKey: true })
    // Plain arrows (used to scroll) never reorder.
    await verify.trigger('keydown', { key: 'ArrowUp' })
    expect(wrapper.emitted('move')).toEqual([
      ['b', -1],
      ['b', 1],
    ])
  })

  it('does not move beyond the ends from the keyboard either', async () => {
    const wrapper = make()
    await wrapper
      .get('[data-testid="step-item-a"] [data-testid="step-select"]')
      .trigger('keydown', { key: 'ArrowUp', altKey: true })
    await wrapper
      .get('[data-testid="step-item-c"] [data-testid="step-select"]')
      .trigger('keydown', { key: 'ArrowDown', altKey: true })
    expect(wrapper.emitted('move')).toBeUndefined()
  })

  it('announces the new order to screen readers in a polite live region', async () => {
    const wrapper = make({ announcement: '' })
    const region = wrapper.get('[data-testid="order-announcement"]')
    expect(region.attributes('role')).toBe('status')
    expect(region.attributes('aria-live')).toBe('polite')
    await wrapper.setProps({
      announcement: 'Verify status moved from position 3 to position 2; connections updated.',
    })
    expect(region.text()).toBe(
      'Verify status moved from position 3 to position 2; connections updated.',
    )
  })

  it('explains why reordering is unavailable for a broken manual flow', () => {
    const wrapper = make({ movable: false })
    expect(wrapper.text()).toContain('Reordering is available once the Steps form one connected')
    expect(
      wrapper
        .findAll('button[aria-label^="Move"]')
        .every((b) => b.attributes('disabled') !== undefined),
    ).toBe(true)
  })

  it('selects and removes Steps', async () => {
    const wrapper = make()
    await wrapper.get('[data-testid="step-item-c"] [data-testid="step-select"]').trigger('click')
    await wrapper.get('[aria-label="Delete Assert result"]').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['c']])
    expect(wrapper.emitted('remove')).toEqual([['c']])
  })
})

// ---- breakpoint configuration -----------------------------------------------------------------------
describe('Breakpoint configuration in the Step inspector', () => {
  const breakpointType: StepTypeMetadata = {
    type: 'breakpoint',
    displayName: 'Breakpoint',
    description: 'Pauses the Run.',
    configSchema: {
      type: 'object',
      required: ['enabled'],
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
        message: { type: 'string', maxLength: 1000 },
      },
    },
    sensitivePaths: [],
    defaults: { enabled: true },
    capabilities: { external: false, supportsRetry: false, supportsArtifacts: false },
  }
  const node: TestNode = {
    id: 'inspect',
    type: 'breakpoint',
    name: 'Inspect',
    parameters: { enabled: true, message: 'Look here' },
  }
  const mountInspector = (parameters = node.parameters) =>
    mount(StepInspector, {
      props: { node: { ...node, parameters }, stepType: breakpointType } as never,
      global,
    })

  it('exposes only the enabled switch and an optional message', () => {
    const wrapper = mountInspector()
    expect(
      wrapper.findAll('[data-testid^="field-"]').map((f) => f.attributes('data-testid')),
    ).toEqual(['field-enabled', 'field-message'])
    expect(wrapper.find('input[type="checkbox"]').element).toHaveProperty('checked', true)
    expect(wrapper.get('#param-inspect-message').attributes('maxlength')).toBe('1000')
    expect(wrapper.get('[data-testid="breakpoint-help"]').text()).toContain(
      'no target, secret or command',
    )
  })

  it('has no target, secret, retry or timeout controls and no expression help', () => {
    const wrapper = mountInspector()
    expect(wrapper.text()).not.toContain('Timeout')
    expect(wrapper.text()).not.toContain('Max attempts')
    expect(wrapper.find('input[type="password"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="expression-help"]').exists()).toBe(false)
    expect(wrapper.findAll('input, textarea, select').length).toBe(3) // name, enabled, message
  })

  it('reports toggling and editing the message', async () => {
    const wrapper = mountInspector()
    await wrapper.get('input[type="checkbox"]').setValue(false)
    expect(wrapper.emitted('update')?.at(-1)).toEqual([
      { parameters: { enabled: false, message: 'Look here' } },
    ])
    await wrapper.get('#param-inspect-message').setValue('Check the payload first')
    expect(wrapper.emitted('update')?.at(-1)).toEqual([
      { parameters: { enabled: true, message: 'Check the payload first' } },
    ])
    await wrapper.get('#param-inspect-message').setValue('')
    expect(wrapper.emitted('update')?.at(-1)).toEqual([{ parameters: { enabled: true } }])
  })
})

// ---- opt-in migration -------------------------------------------------------------------------------
describe('Sequence conversion preview', () => {
  const preview = {
    currentOrder: ['c', 'a', 'b'],
    newOrder: ['c', 'a', 'b'],
    edges: [
      { from: 'c', to: 'a' },
      { from: 'a', to: 'b' },
    ],
    appended: ['b'],
    connectionsChange: true,
  }
  const names = { a: 'Alpha', b: 'Bravo', c: 'Charlie' }

  it('shows nothing destructive until the author asks to review the switch', async () => {
    const wrapper = mount(SequenceConversion, { props: { preview, names }, global })
    expect(wrapper.find('[data-testid="conversion-preview"]').exists()).toBe(false)
    await wrapper.get('[data-testid="open-conversion"]').trigger('click')
    expect(wrapper.get('[data-testid="conversion-order"]').text()).toContain('Charlie')
    expect(wrapper.get('[data-testid="conversion-order"]').text()).toContain('added at the end')
    expect(wrapper.get('[data-testid="conversion-edges"]').text()).toContain('Charlie → Alpha')
    expect(wrapper.get('[data-testid="conversion-summary"]').text()).toContain(
      'connections will change',
    )
    expect(wrapper.emitted('apply')).toBeUndefined()
  })

  it('applies only on explicit confirmation, and can be declined', async () => {
    const wrapper = mount(SequenceConversion, { props: { preview, names }, global })
    await wrapper.get('[data-testid="open-conversion"]').trigger('click')
    await wrapper.get('[data-testid="cancel-conversion"]').trigger('click')
    expect(wrapper.emitted('apply')).toBeUndefined()
    await wrapper.get('[data-testid="open-conversion"]').trigger('click')
    await wrapper.get('[data-testid="apply-conversion"]').trigger('click')
    expect(wrapper.emitted('apply')).toHaveLength(1)
    expect(wrapper.find('[data-testid="conversion-preview"]').exists()).toBe(false)
  })

  it('says when only the management of the connections changes', async () => {
    const wrapper = mount(SequenceConversion, {
      props: { preview: { ...preview, appended: [], connectionsChange: false }, names },
      global,
    })
    await wrapper.get('[data-testid="open-conversion"]').trigger('click')
    expect(wrapper.get('[data-testid="conversion-summary"]').text()).toContain('stay the same')
  })
})

// ---- paused run: masking and actions -----------------------------------------------------------------
describe('Paused Run inspector', () => {
  const pause: RunPause = {
    id: 'p1',
    runId: 'r1',
    breakpointStepRunId: 's2',
    breakpointNodeId: 'inspect',
    message: 'Review the uploaded payload before verifying.',
    nextNodeId: 'verify',
    nextNodeName: 'Verify status',
    nextNodeType: 'assert',
    nextResolvedInputPreview: { actual: 200, headers: { Authorization: '***REDACTED***' } },
    pausedAt: '2026-01-01T00:00:10.000Z',
    continuationGeneration: 2,
  }
  const completed: PausedStepSummary[] = [
    {
      id: 's1',
      nodeId: 'upload',
      attempt: 1,
      status: 'Succeeded',
      durationMs: 120,
      outputPreview: {},
    },
  ]
  const names = { upload: 'Upload order', inspect: 'Inspect order', verify: 'Verify status' }
  const make = (props: Record<string, unknown> = {}) =>
    mount(BreakpointInspector, {
      props: {
        pause,
        completedSteps: completed,
        names,
        runStatus: 'Paused',
        breakpointName: 'Inspect order',
        ...props,
      } as never,
      global,
    })

  it('shows the read-only context: message, completed Steps and the masked next input', () => {
    const wrapper = make()
    expect(wrapper.get('[data-testid="inspection-notice"]').text()).toContain('read-only')
    expect(wrapper.get('[data-testid="pause-message"]').text()).toBe(pause.message)
    expect(wrapper.get('[data-testid="completed-steps"]').text()).toContain('Upload order')
    const input = wrapper.get('[data-testid="next-input"]').text()
    expect(input).toContain('***REDACTED***')
    expect(input).toContain('"actual": 200')
    // Nothing editable is offered: only the two actions are controls.
    expect(wrapper.findAll('input, textarea, select')).toHaveLength(0)
    expect(wrapper.findAll('button').map((b) => b.attributes('data-testid') ?? 'details')).toEqual([
      'details',
      'resume-run',
      'cancel-paused-run',
    ])
  })

  it('never shows a value that was not delivered masked (it renders exactly what the API sent)', () => {
    const wrapper = make({
      pause: { ...pause, nextResolvedInputPreview: { token: '***REDACTED***' } },
    })
    expect(wrapper.html()).not.toContain('super-secret')
    expect(wrapper.text()).toContain('***REDACTED***')
  })

  it('links a stored full input through the artifact endpoint, never a local path', () => {
    const wrapper = make({ pause: { ...pause, nextInputArtifactId: 'art-1' } })
    const href = wrapper.get('[data-testid="next-input-artifact"]').attributes('href')
    expect(href).toMatch(/\/api\/v1\/artifacts\/art-1$/)
    expect(href).toMatch(/^https?:\/\//)
    expect(href).not.toMatch(/runtime|\\|file:/i)
  })

  it('resumes with the inspected generation and cancels on request', async () => {
    const wrapper = make()
    await wrapper.get('[data-testid="resume-run"]').trigger('click')
    await wrapper.get('[data-testid="cancel-paused-run"]').trigger('click')
    expect(wrapper.emitted('resume')).toEqual([[2]])
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('labels the actions with the breakpoint and the next Step', () => {
    const wrapper = make()
    expect(wrapper.get('[data-testid="resume-run"]').attributes('aria-label')).toBe(
      'Resume the Run after breakpoint “Inspect order”; next Step: Verify status',
    )
    expect(wrapper.get('[data-testid="cancel-paused-run"]').attributes('aria-label')).toContain(
      'Verify status will not run',
    )
  })

  it.each(['Running', 'Queued', 'Succeeded', 'Cancelled', 'Cancelling', 'Failed'])(
    'offers no actions when the Run is %s',
    async (status) => {
      const wrapper = make({ runStatus: status })
      expect(wrapper.get('[data-testid="resume-run"]').attributes('disabled')).toBeDefined()
      expect(wrapper.get('[data-testid="cancel-paused-run"]').attributes('disabled')).toBeDefined()
      expect(wrapper.get('[data-testid="not-paused"]').text()).toContain(status)
      await wrapper.get('[data-testid="resume-run"]').trigger('click')
      expect(wrapper.emitted('resume')).toBeUndefined()
    },
  )

  it('disables both actions while one is in flight, so a double click cannot resume twice', () => {
    const resuming = make({ resuming: true })
    expect(resuming.get('[data-testid="resume-run"]').attributes('disabled')).toBeDefined()
    expect(resuming.get('[data-testid="resume-run"]').text()).toBe('Resuming…')
    expect(resuming.get('[data-testid="cancel-paused-run"]').attributes('disabled')).toBeDefined()
    const cancelling = make({ cancelling: true })
    expect(cancelling.get('[data-testid="resume-run"]').attributes('disabled')).toBeDefined()
  })

  it('handles an end-of-flow breakpoint', () => {
    const wrapper = make({
      pause: {
        ...pause,
        nextNodeId: null,
        nextNodeName: undefined,
        nextResolvedInputPreview: undefined,
      },
    })
    expect(wrapper.get('[data-testid="end-of-flow"]').text()).toContain('Resuming finishes the Run')
    expect(wrapper.get('[data-testid="resume-run"]').attributes('aria-label')).toContain(
      'no Step follows',
    )
  })

  it('opens a completed Step and reports the author left no message', async () => {
    const wrapper = make({ pause: { ...pause, message: undefined } })
    await wrapper.get('[aria-label="Output and logs for Upload order"]').trigger('click')
    expect(wrapper.emitted('open-step')).toEqual([['s1']])
    expect(wrapper.text()).toContain('The author left no message.')
  })

  it('shows a conflict from the API without hiding the page', () => {
    const wrapper = make({
      error: Object.assign(new Error('x'), { name: 'ApiError' }),
    })
    expect(wrapper.find('[data-testid="breakpoint-inspector"]').exists()).toBe(true)
  })

  it('renders the prominent banner for the paused node', () => {
    const wrapper = mount(PausedRunBanner, {
      props: {
        breakpointName: 'Inspect order',
        nextName: 'Verify status',
        pausedAt: pause.pausedAt,
      },
      global,
    })
    expect(wrapper.get('[data-testid="paused-title"]').text()).toBe(
      'Paused at breakpoint “Inspect order”',
    )
    expect(wrapper.text()).toContain('Verify status')
    expect(wrapper.text()).toContain('It has not started')
    expect(wrapper.get('[data-testid="paused-banner"]').attributes('role')).toBe('status')
    const end = mount(PausedRunBanner, { props: { breakpointName: 'End' }, global })
    expect(end.text()).toContain('No Step follows')
  })

  it('shows Paused as a distinct, text-labelled state', () => {
    const paused = mount(StatusBadge, { props: { status: 'Paused' }, global })
    const running = mount(StatusBadge, { props: { status: 'Running' }, global })
    expect(paused.text()).toBe('Paused')
    expect(paused.classes().join(' ')).not.toBe(running.classes().join(' '))
    expect(mount(StatusBadge, { props: { status: 'WaitingForBreakpoint' }, global }).text()).toBe(
      'Waiting For Breakpoint',
    )
  })
})

// ---- Suite status -----------------------------------------------------------------------------------
describe('Suite Run summary', () => {
  const zero = {
    total: 0,
    Pending: 0,
    Queued: 0,
    Running: 0,
    Paused: 0,
    Cancelling: 0,
    Succeeded: 0,
    Failed: 0,
    Cancelled: 0,
    Skipped: 0,
  }
  const items: SuiteRunItemView[] = [
    {
      id: 'i0',
      suiteRunId: 's',
      position: 0,
      test: { id: 't0', version: 1 },
      testData: { id: 'd', version: 1 },
      runId: 'run-0',
      status: 'Paused',
      testName: 'Order smoke',
      dataSetName: 'Standard order',
    },
    {
      id: 'i1',
      suiteRunId: 's',
      position: 1,
      test: { id: 't1', version: 1 },
      testData: { id: 'd', version: 1 },
      status: 'Pending',
      testName: 'Refund smoke',
      dataSetName: 'Standard order',
    },
  ]

  it('explains WaitingForBreakpoint and points at the paused child', () => {
    const wrapper = mount(SuiteRunSummary, {
      props: {
        suiteRun: {
          status: 'WaitingForBreakpoint',
          counts: { ...zero, total: 2, Paused: 1, Pending: 1 },
        },
        items,
      },
      global,
    })
    const alert = wrapper.get('[data-testid="waiting-for-breakpoint"]')
    expect(alert.text()).toContain('Waiting for a breakpoint')
    expect(alert.text()).toContain('keep their concurrency slot')
    expect(wrapper.get('[data-testid="count-Paused"]').text()).toBe('1')
    expect(wrapper.get('[data-testid="count-Pending"]').text()).toBe('1')
    expect(wrapper.find('[data-testid="count-Running"]').exists()).toBe(false) // zero counts are hidden

    const link = wrapper.findComponent(RouterLinkStub)
    expect(link.props('to')).toBe('/runs/run-0')
    expect(link.text()).toBe('Resume or cancel…')
    expect(link.attributes('aria-label')).toBe('Open paused child Run for Order smoke')
    expect(wrapper.get('[data-testid="suite-item-1"]').text()).toContain('Not started')
  })

  it('lists children in Suite order with their names and status', () => {
    const wrapper = mount(SuiteRunSummary, {
      props: {
        suiteRun: { status: 'Running', counts: { ...zero, total: 2, Running: 1, Pending: 1 } },
        items: items.map((item, index) => ({
          ...item,
          status: index === 0 ? ('Running' as const) : ('Pending' as const),
        })),
      },
      global,
    })
    expect(wrapper.find('[data-testid="waiting-for-breakpoint"]').exists()).toBe(false)
    expect(wrapper.findAll('tbody tr').map((row) => row.get('td:nth-child(2)').text())).toEqual([
      'Order smoke',
      'Refund smoke',
    ])
    expect(wrapper.get('[data-testid="count-total"]').text()).toBe('2')
  })

  it('has a compact form without the table', () => {
    const wrapper = mount(SuiteRunSummary, {
      props: { suiteRun: { status: 'Succeeded', counts: { ...zero, total: 3, Succeeded: 3 } } },
      global,
    })
    expect(wrapper.find('table').exists()).toBe(false)
    expect(wrapper.get('[data-testid="count-Succeeded"]').text()).toBe('3')
  })
})
