import { expect, test, type Page } from '@playwright/test'
import { replaceEditorText } from './helpers'

const API = 'http://127.0.0.1:3100/api/v1'
const suffix = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5)

const createTestData = async (page: Page, name: string) => {
  await page.goto('/test-data/new')
  await page.getByLabel('Name', { exact: true }).fill(name)
  await replaceEditorText(page, page.getByLabel('Data (JSON object)'), '{"order": {"id": "ORD-1"}}')
  await page.getByTestId('save-test-data').click()
  await expect(page.getByText('Saved · v1')).toBeVisible()
}

test.describe('Breakpoint: Delay → Breakpoint → Assert', () => {
  test.use({ viewport: { width: 1440, height: 1400 } })

  test('pauses at the Breakpoint, shows what it is waiting on, and resumes to completion', async ({
    page,
  }) => {
    const id = suffix()
    const dataName = `Breakpoint data ${id}`
    const testName = `Breakpoint flow ${id}`
    await createTestData(page, dataName)

    // --- build the Test in the editor ----------------------------------------------------------
    await page.goto('/tests/new')
    await page.getByLabel('Name', { exact: true }).fill(testName)
    await page.getByRole('button', { name: 'Add Delay Step' }).click()
    await page.getByRole('button', { name: 'Add Breakpoint Step' }).click()
    await page.getByRole('button', { name: 'Add Assert Step' }).click()

    const list = page.getByTestId('step-list')
    await expect(list.getByRole('listitem')).toHaveCount(3)
    const inspector = page.getByTestId('step-inspector')

    await list.getByRole('button', { name: 'Delay', exact: true }).click()
    await inspector.getByLabel('Duration Seconds').fill('0.1')

    // The Breakpoint exposes only "enabled" and a message; nothing about targets or secrets.
    await list.getByRole('button', { name: 'Breakpoint', exact: true }).click()
    await expect(inspector.getByTestId('breakpoint-help')).toBeVisible()
    await expect(inspector.getByLabel('Enabled')).toBeChecked()
    await inspector.getByLabel('Message').fill('Review the order before it is verified.')
    await expect(inspector.getByText('Timeout')).toHaveCount(0)

    await list.getByRole('button', { name: 'Assert', exact: true }).click()
    await inspector.getByLabel('Actual').fill('{{testData.order.id}}')
    await inspector.getByLabel('Expected').fill('ORD-1')

    await page.getByTestId('save-test').click()
    await expect(page).toHaveURL(/\/tests\/[\w-]+$/)
    await expect(page.getByText('Saved · v1')).toBeVisible()
    await page.getByTestId('validate-test').click()
    await expect(page.getByTestId('validation-result')).toContainText(
      'The server accepts this Test.',
    )

    // --- run it ----------------------------------------------------------------------------------
    await page.getByRole('link', { name: 'Run', exact: true }).click()
    await page.getByLabel('Test Data', { exact: true }).selectOption({ label: dataName })
    await page.getByTestId('launch-run').click()
    await expect(page).toHaveURL(/\/runs\/[\w-]+$/)

    // --- paused ------------------------------------------------------------------------------------
    const status = page.getByTestId('run-status')
    await expect(status).toHaveAttribute('data-status', 'Paused', { timeout: 30_000 })
    await expect(page.getByTestId('paused-title')).toHaveText(/Paused at breakpoint “Breakpoint”/)
    await expect(page.getByTestId('pause-message')).toHaveText(
      'Review the order before it is verified.',
    )
    // The completed Delay is listed; the Assert after the Breakpoint has not started.
    await expect(page.getByTestId('completed-steps')).toContainText('Delay')
    await expect(page.getByTestId('next-input')).toContainText('"actual": "ORD-1"')
    const rows = page.getByTestId('step-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.filter({ hasText: 'Assert' })).toHaveCount(0)
    // The paused Step is highlighted on the canvas and the header offers no competing Cancel.
    await expect(page.getByTestId('flow-canvas').locator('.step-node.paused')).toHaveCount(1)
    await expect(page.getByTestId('cancel-run')).toHaveCount(0)

    // Inspection is read-only: the only controls are the two actions and the Details links.
    await expect(
      page.getByTestId('breakpoint-inspector').locator('input, textarea, select'),
    ).toHaveCount(0)

    // --- resume ------------------------------------------------------------------------------------
    await page.getByTestId('resume-run').click()
    await expect(status).toHaveAttribute('data-status', 'Succeeded', { timeout: 30_000 })
    await expect(page.getByTestId('paused-banner')).toHaveCount(0)
    await expect(page.getByTestId('breakpoint-inspector')).toHaveCount(0)
    await expect(rows).toHaveCount(3)
    await expect(rows.filter({ hasText: 'Assert' }).getByText('Succeeded')).toBeVisible()
    await expect(rows.filter({ hasText: 'Breakpoint' }).getByText('Succeeded')).toBeVisible()
  })

  test('a paused Run can be cancelled and the Step after it never runs', async ({
    page,
    request,
  }) => {
    const id = suffix()
    const data = await request.post(`${API}/test-data`, {
      data: { name: `Cancel data ${id}`, data: { value: 1 } },
    })
    const dataSet = (await data.json()) as { id: string }
    const test = await request.post(`${API}/tests`, {
      data: {
        name: `Cancel while paused ${id}`,
        nodes: [
          { id: 'inspect', type: 'breakpoint', name: 'Inspect', parameters: { enabled: true } },
          {
            id: 'verify',
            type: 'assert',
            name: 'Verify',
            parameters: { actual: 1, operator: 'equals', expected: 1 },
          },
        ],
        edges: [{ from: 'inspect', to: 'verify' }],
      },
    })
    const testAsset = (await test.json()) as { id: string }
    const run = await request.post(`${API}/runs`, {
      data: { testId: testAsset.id, dataSetId: dataSet.id, environmentId: 'local-test' },
    })
    const { id: runId } = (await run.json()) as { id: string }

    await page.goto(`/runs/${runId}`)
    await expect(page.getByTestId('run-status')).toHaveAttribute('data-status', 'Paused', {
      timeout: 30_000,
    })
    await expect(page.getByTestId('end-of-flow')).toHaveCount(0)
    await page.getByTestId('cancel-paused-run').click()
    await expect(page.getByTestId('run-status')).toHaveAttribute('data-status', 'Cancelled', {
      timeout: 30_000,
    })
    await expect(page.getByTestId('step-row').filter({ hasText: 'Verify' })).toHaveCount(0)
    await expect(page.getByTestId('rerun-run')).toBeVisible()
  })
})

test.describe('Position-driven sequencing', () => {
  test.use({ viewport: { width: 1440, height: 1400 } })

  const addThree = async (page: Page) => {
    await page.goto('/tests/new')
    await page.getByLabel('Name', { exact: true }).fill(`Sequence ${suffix()}`)
    await page.getByRole('button', { name: 'Add Delay Step' }).click()
    await page.getByRole('button', { name: 'Add Assert Step' }).click()
    // The new Step is selected; give it the settings the server requires so the Test can be saved.
    await page.getByTestId('step-inspector').getByLabel('Actual').fill('1')
    await page.getByTestId('step-inspector').getByLabel('Expected').fill('1')
    await page.getByRole('button', { name: 'Add Breakpoint Step' }).click()
  }
  const orderNames = (page: Page) =>
    page.getByTestId('step-list').locator('li').getByTestId('step-select').allTextContents()

  test('reorders from the keyboard, announces it, and supports undo and redo', async ({ page }) => {
    await addThree(page)
    expect((await orderNames(page)).map((t) => t.trim())).toEqual(['Delay', 'Assert', 'Breakpoint'])

    await page.getByRole('button', { name: 'Move Breakpoint earlier, from position 3' }).click()
    expect((await orderNames(page)).map((t) => t.trim())).toEqual(['Delay', 'Breakpoint', 'Assert'])
    await expect(page.getByTestId('order-announcement')).toHaveText(
      'Breakpoint moved from position 3 to position 2; connections updated.',
    )

    // Alt+ArrowUp on the focused list entry moves it one place earlier as well.
    await page.getByTestId('step-item-breakpoint').getByTestId('step-select').focus()
    await page.keyboard.press('Alt+ArrowUp')
    expect((await orderNames(page)).map((t) => t.trim())).toEqual(['Breakpoint', 'Delay', 'Assert'])

    await page.getByTestId('undo').click()
    expect((await orderNames(page)).map((t) => t.trim())).toEqual(['Delay', 'Breakpoint', 'Assert'])
    await page.getByTestId('redo').click()
    expect((await orderNames(page)).map((t) => t.trim())).toEqual(['Breakpoint', 'Delay', 'Assert'])
    await page.getByTestId('undo').click()
    await page.getByTestId('undo').click()
    await expect(page.getByTestId('undo')).toBeEnabled() // adding Steps is undoable too
    expect((await orderNames(page)).map((t) => t.trim())).toEqual(['Delay', 'Assert', 'Breakpoint'])
  })

  test('dragging a Step above another reorders it, shows the marker, and the saved order wins', async ({
    page,
  }) => {
    await addThree(page)
    const canvas = page.getByTestId('flow-canvas')
    await expect(canvas.locator('.vue-flow__node')).toHaveCount(3)
    await expect(canvas.locator('.vue-flow__edge')).toHaveCount(2)
    await page.waitForTimeout(600) // let the animated fit finish

    const node = (id: string) => canvas.locator(`.vue-flow__node[data-id="${id}"] .step-node`)
    const first = (await node('delay').boundingBox())!
    const last = (await node('breakpoint').boundingBox())!

    // Grab the last Step by its body and drag it above the first.
    await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2)
    await page.mouse.down()
    await page.mouse.move(first.x + first.width / 2, first.y - 20, { steps: 15 })
    await expect(page.getByTestId('insertion-marker')).toBeVisible() // visible while dragging
    await page.mouse.up()
    await expect(page.getByTestId('insertion-marker')).toHaveCount(0)

    expect((await orderNames(page)).map((t) => t.trim())).toEqual(['Breakpoint', 'Delay', 'Assert'])
    await expect(canvas.locator('.vue-flow__edge')).toHaveCount(2)

    // Undo restores the previous order before anything is saved.
    await page.getByTestId('undo').click()
    expect((await orderNames(page)).map((t) => t.trim())).toEqual(['Delay', 'Assert', 'Breakpoint'])
    await page.getByTestId('redo').click()

    await page.getByTestId('save-test').click()
    await expect(page.getByText('Saved · v1')).toBeVisible()
    await page.reload()
    // After a reload only the saved, server-normalized layout remains.
    await expect(page.getByTestId('sequence-mode')).toHaveText('Position-driven')
    expect((await orderNames(page)).map((t) => t.trim())).toEqual(['Breakpoint', 'Delay', 'Assert'])
    await expect(page.getByTestId('undo')).toBeDisabled()
  })

  test('a small nudge does not reorder', async ({ page }) => {
    await addThree(page)
    const canvas = page.getByTestId('flow-canvas')
    await expect(canvas.locator('.vue-flow__node')).toHaveCount(3)
    await page.waitForTimeout(600)
    const box = (await canvas
      .locator('.vue-flow__node[data-id="assert"] .step-node')
      .boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 25, box.y + box.height / 2 + 4, { steps: 5 })
    await page.mouse.up()
    expect((await orderNames(page)).map((t) => t.trim())).toEqual(['Delay', 'Assert', 'Breakpoint'])
  })

  test('opting an existing Test in previews the order first and is undoable', async ({
    page,
    request,
  }) => {
    const created = await request.post(`${API}/tests`, {
      data: {
        name: `Legacy ${suffix()}`,
        nodes: ['b', 'a'].map((nodeId) => ({
          id: nodeId,
          type: 'delay',
          name: `Step ${nodeId}`,
          parameters: { durationSeconds: 0.01 },
        })),
        edges: [{ from: 'b', to: 'a' }],
      },
    })
    const { id } = (await created.json()) as { id: string }

    await page.goto(`/tests/${id}`)
    await expect(page.getByTestId('sequence-mode')).toHaveText('Manual connections')
    await page.getByTestId('open-conversion').click()
    await expect(page.getByTestId('conversion-order')).toContainText('Step b')
    await expect(page.getByTestId('conversion-edges')).toContainText('Step b → Step a')
    // Reviewing changes nothing.
    await expect(page.getByTestId('sequence-mode')).toHaveText('Manual connections')
    await expect(page.getByTestId('unsaved-badge')).toHaveCount(0)

    await page.getByTestId('apply-conversion').click()
    await expect(page.getByTestId('sequence-mode')).toHaveText('Position-driven')
    await expect(page.getByTestId('unsaved-badge')).toBeVisible()
    await page.getByTestId('undo').click()
    await expect(page.getByTestId('sequence-mode')).toHaveText('Manual connections')
    await page.getByTestId('redo').click()

    await page.getByTestId('save-test').click()
    await expect(page.getByText('Saved · v2')).toBeVisible()
    const saved = await (await request.get(`${API}/tests/${id}`)).json()
    expect(saved.editor).toEqual({ layoutDirection: 'vertical', autoSequenceFromPosition: true })
    expect(saved.edges).toEqual([{ from: 'b', to: 'a', metadata: { systemManaged: true } }])
  })
})

test.describe('Suite Runs', () => {
  test.use({ viewport: { width: 1440, height: 1400 } })

  test('runs a Suite sequentially, waits at a child Breakpoint, and finishes after Resume', async ({
    page,
    request,
  }) => {
    const id = suffix()
    const dataSet = (await (
      await request.post(`${API}/test-data`, { data: { name: `Suite data ${id}`, data: {} } })
    ).json()) as { id: string }
    const make = async (name: string, nodes: object[], edges: object[]) =>
      (
        (await (await request.post(`${API}/tests`, { data: { name, nodes, edges } })).json()) as {
          id: string
        }
      ).id
    const withBreakpoint = await make(
      `First (breakpoint) ${id}`,
      [
        { id: 'inspect', type: 'breakpoint', name: 'Inspect', parameters: { enabled: true } },
        { id: 'wait', type: 'delay', name: 'Wait', parameters: { durationSeconds: 0.01 } },
      ],
      [{ from: 'inspect', to: 'wait' }],
    )
    const plain = await make(
      `Second ${id}`,
      [{ id: 'wait', type: 'delay', name: 'Wait', parameters: { durationSeconds: 0.01 } }],
      [],
    )
    const suiteResponse = await request.post(`${API}/suites`, {
      data: {
        name: `Suite ${id}`,
        items: [
          { testId: withBreakpoint, dataSetId: dataSet.id },
          { testId: plain, dataSetId: dataSet.id },
        ],
      },
    })
    const suite = (await suiteResponse.json()) as { id: string }

    // --- launch: concurrency is bounded by the Environment ---------------------------------------
    await page.goto(`/suite-runs/new?suiteId=${suite.id}`)
    await page.getByLabel('Environment', { exact: true }).selectOption('local-test')
    await expect(page.getByTestId('concurrency-help')).toContainText('up to 2')
    await page.getByTestId('concurrency-input').fill('3')
    await page.getByTestId('launch-suite-run').click()
    await expect(page.getByTestId('launch-error')).toContainText('from 1 to 2')
    await page.getByTestId('concurrency-input').fill('1')
    await page.getByTestId('launch-suite-run').click()
    await expect(page).toHaveURL(/\/suite-runs\/[\w-]+$/)

    // --- waiting for the child's Breakpoint ------------------------------------------------------
    await expect(page.getByTestId('suite-run-status')).toHaveAttribute(
      'data-status',
      'WaitingForBreakpoint',
      { timeout: 30_000 },
    )
    await expect(page.getByTestId('waiting-for-breakpoint')).toBeVisible()
    await expect(page.getByTestId('suite-item-0')).toContainText('Paused')
    await expect(page.getByTestId('suite-item-1')).toContainText('Not started')
    await expect(page.getByTestId('suite-concurrency')).toContainText('1 at a time')

    // --- resume the child, then the Suite completes -------------------------------------------------
    await page.getByTestId('suite-item-0').getByRole('link').click()
    await expect(page.getByTestId('run-status')).toHaveAttribute('data-status', 'Paused')
    await page.getByTestId('resume-run').click()
    await expect(page.getByTestId('run-status')).toHaveAttribute('data-status', 'Succeeded', {
      timeout: 30_000,
    })
    await page.goBack()
    await expect(page.getByTestId('suite-run-status')).toHaveAttribute('data-status', 'Succeeded', {
      timeout: 30_000,
    })
    await expect(page.getByTestId('count-Succeeded')).toHaveText('2')
    await expect(page.getByTestId('rerun-suite-run')).toBeVisible()

    // --- rerun --------------------------------------------------------------------------------------
    await page.getByTestId('rerun-suite-run').click()
    await expect(page).toHaveURL(/\/suite-runs\/[\w-]+$/)
    await expect(page.getByText('rerun of')).toBeVisible()
  })

  test('cancels a Suite Run', async ({ page, request }) => {
    const id = suffix()
    const dataSet = (await (
      await request.post(`${API}/test-data`, {
        data: { name: `Cancel suite data ${id}`, data: {} },
      })
    ).json()) as { id: string }
    const gate = (await (
      await request.post(`${API}/tests`, {
        data: {
          name: `Gate ${id}`,
          nodes: [
            { id: 'inspect', type: 'breakpoint', name: 'Inspect', parameters: { enabled: true } },
          ],
          edges: [],
        },
      })
    ).json()) as { id: string }
    const suite = (await (
      await request.post(`${API}/suites`, {
        data: {
          name: `Cancel suite ${id}`,
          items: [
            { testId: gate.id, dataSetId: dataSet.id },
            { testId: gate.id, dataSetId: dataSet.id },
          ],
        },
      })
    ).json()) as { id: string }
    const started = await request.post(`${API}/suite-runs`, {
      data: { suiteId: suite.id, environmentId: 'local-test' },
    })
    const { id: suiteRunId } = (await started.json()) as { id: string }

    await page.goto(`/suite-runs/${suiteRunId}`)
    await expect(page.getByTestId('suite-run-status')).toHaveAttribute(
      'data-status',
      'WaitingForBreakpoint',
      { timeout: 30_000 },
    )
    await page.getByTestId('cancel-suite-run').click()
    await expect(page.getByTestId('suite-run-status')).toHaveAttribute('data-status', 'Cancelled', {
      timeout: 30_000,
    })
    await expect(page.getByTestId('suite-item-0')).toContainText('Cancelled')
    await expect(page.getByTestId('suite-item-1')).toContainText('Skipped')
  })
})
