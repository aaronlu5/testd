import { expect, test } from '@playwright/test'
import { replaceEditorText } from './helpers'

// Drives the real UI against the real API and worker using only the dependency-free Steps.
test('create Test Data, build a Test, run it, and inspect the completed Step result', async ({
  page,
}) => {
  const suffix = Date.now().toString(36)
  const dataName = `Order data ${suffix}`
  const testName = `Order check ${suffix}`

  // --- Test Data -----------------------------------------------------------------------------
  await page.goto('/test-data/new')
  await page.getByLabel('Name', { exact: true }).fill(dataName)
  await replaceEditorText(
    page,
    page.getByLabel('Data (JSON object)'),
    '{"order": {"id": "ORD-1", "total": 42}}',
  )
  await page.getByTestId('validate-json').click()
  await expect(page.getByTestId('json-valid')).toBeVisible()
  await page.getByTestId('save-test-data').click()
  await expect(page).toHaveURL(/\/test-data\/[\w-]+$/)
  await expect(page.getByText('Saved · v1')).toBeVisible()

  // --- Test ----------------------------------------------------------------------------------
  await page.goto('/tests/new')
  await page.getByLabel('Name', { exact: true }).fill(testName)
  await page.getByRole('button', { name: 'Add Delay Step' }).click()
  await page.getByRole('button', { name: 'Add Transform JSON Step' }).click()
  await page.getByRole('button', { name: 'Add Assert Step' }).click()
  await expect(page.getByTestId('step-list').getByRole('listitem')).toHaveCount(3)

  const stepList = page.getByTestId('step-list')
  const inspector = page.getByTestId('step-inspector')

  await stepList.getByRole('button', { name: 'Delay', exact: true }).click()
  await inspector.getByLabel('Duration Seconds').fill('0.1')

  await stepList.getByRole('button', { name: 'Transform JSON', exact: true }).click()
  await replaceEditorText(
    page,
    inspector.getByLabel('Input', { exact: false }).first(),
    '{{testData.order}}',
  )
  await replaceEditorText(page, inspector.getByLabel('Mapping'), '{"id": "$.id"}')

  await stepList.getByRole('button', { name: 'Assert', exact: true }).click()
  await replaceEditorText(
    page,
    inspector.getByLabel('Actual'),
    '{{steps.transform-json.output.id}}',
  )
  await inspector.getByLabel('Expected').fill('ORD-1')

  // Unsaved edits are flagged, then saved and validated by the server.
  await expect(page.getByTestId('unsaved-badge')).toBeVisible()
  await page.getByTestId('save-test').click()
  await expect(page).toHaveURL(/\/tests\/[\w-]+$/)
  await expect(page.getByText('Saved · v1')).toBeVisible()
  await page.getByTestId('validate-test').click()
  await expect(page.getByTestId('validation-result')).toContainText('The server accepts this Test.')

  // --- Run -----------------------------------------------------------------------------------
  await page.getByRole('link', { name: 'Run', exact: true }).click()
  await expect(page.getByTestId('run-launcher')).toBeVisible()
  await page.getByLabel('Test Data', { exact: true }).selectOption({ label: dataName })
  await page.getByTestId('launch-run').click()

  await expect(page).toHaveURL(/\/runs\/[\w-]+$/)
  await expect(page.getByTestId('run-summary').locator('[data-status]').first()).toHaveAttribute(
    'data-status',
    'Succeeded',
    { timeout: 30_000 },
  )

  // --- Inspect -------------------------------------------------------------------------------
  const rows = page.getByTestId('step-row')
  await expect(rows).toHaveCount(3)
  await rows
    .filter({ hasText: 'Transform JSON' })
    .getByRole('button', { name: /Details/ })
    .click()
  const detail = page.getByTestId('step-run-detail')
  await expect(detail).toBeVisible()
  await expect(detail.getByTestId('step-input')).toContainText('ORD-1')
  await expect(detail.getByTestId('step-output')).toContainText('"id": "ORD-1"')
  await expect(detail).toContainText('Succeeded')
})

test('a failing assertion is reported with its cause', async ({ page }) => {
  const suffix = Date.now().toString(36)
  await page.goto('/test-data/new')
  await page.getByLabel('Name', { exact: true }).fill(`Fail data ${suffix}`)
  await replaceEditorText(page, page.getByLabel('Data (JSON object)'), '{"value": 1}')
  await page.getByTestId('save-test-data').click()
  await expect(page.getByText('Saved · v1')).toBeVisible()

  await page.goto('/tests/new')
  await page.getByLabel('Name', { exact: true }).fill(`Failing check ${suffix}`)
  await page.getByRole('button', { name: 'Add Assert Step' }).click()
  const inspector = page.getByTestId('step-inspector')
  await inspector.getByLabel('Actual').fill('{{testData.value}}')
  await inspector.getByLabel('Expected').fill('2')
  await page.getByTestId('save-test').click()
  await expect(page.getByText('Saved · v1')).toBeVisible()

  await page.getByRole('link', { name: 'Run', exact: true }).click()
  await page.getByLabel('Test Data', { exact: true }).selectOption({ label: `Fail data ${suffix}` })
  await page.getByTestId('launch-run').click()

  await expect(page.getByTestId('run-error')).toContainText('EXECUTION_ASSERTION_FAILED', {
    timeout: 30_000,
  })
  await expect(page.getByTestId('run-error')).toContainText('Assertion')
  await expect(page.getByTestId('rerun-run')).toBeVisible()
})

const API = 'http://127.0.0.1:3100/api/v1'

test.describe('Test editor canvas', () => {
  // Tall enough that all three Steps and their handles are on screen for mouse dragging.
  test.use({ viewport: { width: 1440, height: 1400 } })

  test('a Test with manual connections can still be edited by hand', async ({ page, request }) => {
    // Seeded without editor settings, like a Test authored before position sequencing existed.
    const created = await request.post(`${API}/tests`, {
      data: {
        name: `Manual check ${Date.now().toString(36)}`,
        nodes: ['delay', 'delay-2', 'delay-3'].map((id) => ({
          id,
          type: 'delay',
          name: id,
          parameters: { durationSeconds: 0.01 },
        })),
        edges: [
          { from: 'delay', to: 'delay-2' },
          { from: 'delay-2', to: 'delay-3' },
        ],
      },
    })
    expect(created.status()).toBe(201)
    const { id } = (await created.json()) as { id: string }

    await page.goto(`/tests/${id}`)
    await expect(page.getByTestId('sequence-mode')).toHaveText('Manual connections')
    await expect(page.getByTestId('sequence-conversion')).toBeVisible()
    const canvas = page.getByTestId('flow-canvas')
    await expect(canvas.locator('.vue-flow__node')).toHaveCount(3)
    await expect(canvas.locator('.vue-flow__edge')).toHaveCount(2)

    // Remove a connection, then draw it again by dragging between the handles.
    await canvas.locator('.vue-flow__edge').first().click({ force: true })
    await page.getByRole('button', { name: 'Remove connection' }).click()
    await expect(canvas.locator('.vue-flow__edge')).toHaveCount(1)
    await page.waitForTimeout(600)

    const source = await canvas
      .locator('.vue-flow__node[data-id="delay"]')
      .locator('.vue-flow__handle.source')
      .boundingBox()
    const target = await canvas
      .locator('.vue-flow__node[data-id="delay-2"]')
      .locator('.vue-flow__handle.target')
      .boundingBox()
    expect(source && target).toBeTruthy()
    expect(source!.width).toBeGreaterThanOrEqual(12)
    await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2)
    await page.mouse.down()
    await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, {
      steps: 10,
    })
    await page.mouse.up()
    await expect(canvas.locator('.vue-flow__edge')).toHaveCount(2)
  })

  test('starts empty for a new Test and shows connections as Steps are added', async ({ page }) => {
    await page.goto('/tests/new')
    await page.getByLabel('Name', { exact: true }).fill(`Canvas check ${Date.now().toString(36)}`)
    await expect(page.getByTestId('sequence-mode')).toHaveText('Position-driven')
    await page.getByRole('button', { name: 'Add Delay Step' }).click()
    await page.getByRole('button', { name: 'Add Delay Step' }).click()
    await page.getByRole('button', { name: 'Add Delay Step' }).click()

    const canvas = page.getByTestId('flow-canvas')
    await expect(canvas.locator('.vue-flow__node')).toHaveCount(3)
    await expect(canvas.locator('.vue-flow__edge')).toHaveCount(2)

    // Save, then open a new Test from the library: nothing from the previous one is shown.
    await page.getByTestId('save-test').click()
    await expect(page.getByText('Saved · v1')).toBeVisible()
    await page.getByRole('link', { name: 'Tests', exact: true }).first().click()
    await page.getByTestId('new-asset').click()
    await expect(page).toHaveURL(/\/tests\/new$/)
    await expect(page.locator('#test-name')).toHaveValue('')
    await expect(page.getByTestId('flow-canvas').locator('.vue-flow__node')).toHaveCount(0)
    await expect(page.getByTestId('flow-canvas').locator('.vue-flow__edge')).toHaveCount(0)
  })
})
