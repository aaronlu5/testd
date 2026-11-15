import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from '@playwright/test'

// The Service Bus is never contacted in these tests (the worker's inspector poll interval is set
// to five minutes in backend.mjs). Messages are placed in the local store the same way the worker
// would, so the badge, panel, detail view and clear can be exercised without Azure.
const API = 'http://127.0.0.1:3100/api/v1'
// Playwright runs from apps/web; backend.mjs keeps its throwaway state under e2e/.runtime.
const DB = join(process.cwd(), 'e2e', '.runtime', 'runtime', 'platform.db')

const withDb = <T>(work: (db: DatabaseSync) => T): T => {
  const db = new DatabaseSync(DB)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    return work(db)
  } finally {
    db.close()
  }
}

const insertMessage = (n: number, body: unknown, subject = `order.created.${n}`) =>
  withDb((db) => {
    const id = randomUUID()
    const now = new Date().toISOString()
    const detail = {
      id,
      seq: 0,
      origin: 'received',
      receivedAt: now,
      environmentId: 'local-test',
      target: 'bus',
      entity: 'orders',
      messageId: `m-${n}`,
      correlationId: `corr-${n}`,
      subject,
      contentType: 'application/json',
      sizeBytes: 42,
      preview: JSON.stringify(body),
      sequenceNumber: String(n),
      deliveryCount: 1,
      applicationProperties: { region: 'eu', platform_run_id: 'run-abc' },
      bodyEncoding: 'json',
      body,
      bodyTruncated: false,
      runId: 'run-abc',
    }
    db.prepare(
      `INSERT INTO sb_inspector_messages (id, watch_id, origin, received_at, environment_id, target, entity,
         subscription, message_id, subject, content_type, size_bytes, preview, run_id, sequence_number, detail)
       VALUES (?, NULL, 'received', ?, 'local-test', 'bus', 'orders', '', ?, ?, 'application/json', 42, ?, 'run-abc', ?, ?)`,
    ).run(id, now, `m-${n}`, subject, JSON.stringify(body), String(n), JSON.stringify(detail))
  })

test.beforeEach(async ({ request }) => {
  await request.post(`${API}/inspector/clear`, { headers: { Origin: 'http://127.0.0.1:4173' } })
  withDb((db) => {
    db.exec('DELETE FROM sb_inspector_watches')
    db.exec('UPDATE sb_inspector_state SET last_viewed_seq = 0')
  })
})

test('shows a badge for new messages, lists them in the panel, and expands one into detail', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.getByTestId('inspector-toggle')).toBeVisible()
  await expect(page.getByTestId('inspector-badge')).toHaveCount(0)

  insertMessage(1, { orderId: 'ORD-1', total: 12.5 })
  insertMessage(2, { orderId: 'ORD-2', total: 7 })
  await expect(page.getByTestId('inspector-badge')).toHaveText('2', { timeout: 15_000 })

  await page.getByTestId('inspector-toggle').click()
  const panel = page.getByTestId('inspector-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByTestId('inspector-count')).toContainText('2 messages')
  const messages = panel.getByTestId('inspector-messages').locator('> li')
  await expect(messages).toHaveCount(2)
  // Newest first, both flagged new, badge cleared because the panel has shown them.
  await expect(messages.first()).toContainText('order.created.2')
  await expect(panel.getByTestId('inspector-new-badge')).toHaveCount(2)
  await expect(page.getByTestId('inspector-badge')).toHaveCount(0, { timeout: 15_000 })

  await messages.first().getByRole('button').click()
  const detail = messages.first().getByTestId('inspector-detail')
  await expect(detail.getByTestId('inspector-body')).toContainText('"orderId": "ORD-2"')
  await expect(detail).toContainText('Correlation ID')
  await expect(detail).toContainText('corr-2')
  await expect(detail).toContainText('Application properties')
  await expect(detail).toContainText('region')
  await expect(detail.getByRole('link', { name: 'run-abc' })).toHaveAttribute(
    'href',
    '/runs/run-abc',
  )

  // Collapse again.
  await messages.first().getByRole('button').click()
  await expect(detail).toHaveCount(0)
})

test('keeps history after closing, flags only newer messages, and clears on request', async ({
  page,
}) => {
  insertMessage(1, { orderId: 'ORD-1' })
  await page.goto('/')
  await expect(page.getByTestId('inspector-badge')).toHaveText('1', { timeout: 15_000 })
  await page.getByTestId('inspector-toggle').click()
  const panel = page.getByTestId('inspector-panel')
  await expect(panel.getByTestId('inspector-messages').locator('> li')).toHaveCount(1)
  await panel.getByRole('button', { name: /close/i }).click()
  await expect(panel).toBeHidden()

  // Old messages remain, are no longer new, and a later arrival raises the badge again.
  insertMessage(2, { orderId: 'ORD-2' })
  await expect(page.getByTestId('inspector-badge')).toHaveText('1', { timeout: 15_000 })
  await page.getByTestId('inspector-toggle').click()
  await expect(panel.getByTestId('inspector-messages').locator('> li')).toHaveCount(2)
  await expect(panel.getByTestId('inspector-new-badge')).toHaveCount(1)
  await expect(
    panel.getByTestId('inspector-message-1').getByTestId('inspector-new-badge'),
  ).toHaveCount(0)

  // Nothing is removed until the user clears, and clearing needs a second click.
  await panel.getByTestId('inspector-clear').click()
  await expect(panel.getByTestId('inspector-messages').locator('> li')).toHaveCount(2)
  await panel.getByTestId('inspector-clear-confirm').click()
  await expect(panel.getByTestId('inspector-empty')).toBeVisible()
  await expect(panel.getByTestId('inspector-count')).toContainText('0 messages')
})

test('a queue or topic can be added to the watch list manually and removed again', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByTestId('inspector-toggle').click()
  const panel = page.getByTestId('inspector-panel')
  await panel.getByTestId('inspector-watches-toggle').click()
  await expect(panel.getByTestId('inspector-no-watches')).toBeVisible()

  const form = panel.getByTestId('inspector-add-form')
  await expect(form.getByLabel('Environment and target')).toContainText('bus')
  await form.getByLabel('Queue or topic').selectOption('events')
  await form.getByLabel('Subscription (topics only)').fill('inspector')
  await form.getByRole('button', { name: 'Start watching' }).click()

  const watches = panel.getByTestId('inspector-watches')
  await expect(watches).toContainText('bus / events ▸ inspector')
  await expect(watches).toContainText('added manually')
  await expect(watches).toContainText('Waiting for first check')

  await watches.getByRole('button', { name: /Stop watching/ }).click()
  await expect(panel.getByTestId('inspector-no-watches')).toBeVisible()
})
