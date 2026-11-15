import { expect, test, type APIRequestContext } from '@playwright/test'

// Environments and secrets are edited through the real API; the backend keeps its state in a
// throwaway directory (see backend.mjs). Values below are test-only.
const API = 'http://127.0.0.1:3100/api/v1'
const ORIGIN = { Origin: 'http://127.0.0.1:4173' }
const SECRET_VALUE = 'e2e-plain-text-secret-0123456789'

const cleanUp = async (request: APIRequestContext) => {
  const list = await (await request.get(`${API}/environment-configs`)).json()
  let revision: string = list.revision
  for (const environment of list.items as { id: string }[]) {
    if (!environment.id.startsWith('e2e-')) continue
    const response = await request.delete(
      `${API}/environment-configs/${environment.id}?revision=${revision}`,
      { headers: ORIGIN },
    )
    revision = (await response.json()).revision
  }
  await request.delete(`${API}/secrets/local/e2e-api-key`, { headers: ORIGIN })
}

test.beforeEach(({ request }) => cleanUp(request))
test.afterEach(({ request }) => cleanUp(request))

test('creates, edits and deletes an Environment, and the Test picker sees it', async ({ page }) => {
  await page.goto('/environments')
  await expect(page.getByTestId('environment-row-local-test')).toBeVisible()

  await page.getByTestId('new-environment').click()
  const form = page.getByTestId('environment-form')
  await form.getByLabel('Id', { exact: true }).fill('e2e-orders')
  await form.getByLabel('Name', { exact: true }).fill('E2E orders')
  await form.getByTestId('add-target-http').click()
  const target = form.locator('.target-card').last()
  await target.getByLabel('Target name').fill('orders-api')
  await target.getByLabel('Base URL').fill('https://example.azure-api.net')
  await target.getByLabel('Allowed paths (one per line)').fill('/orders/*')
  await target.getByLabel('Source').selectOption('keyVault')
  await target.getByLabel('Secret name or URI').fill('orders-api-key')
  await page.getByTestId('save-environment').click()

  await expect(page).toHaveURL(/\/environments$/)
  const row = page.getByTestId('environment-row-e2e-orders')
  await expect(row).toContainText('E2E orders')
  await expect(row).toContainText('orders-api')
  await expect(row).toContainText('https://example.azure-api.net')

  // The Test editor's picker lists it straight away.
  await page.goto('/tests/new')
  await expect(page.getByRole('option', { name: /E2E orders/ })).toBeAttached()

  // Edit: rename and add a limit; the id is fixed.
  await page.goto('/environments/e2e-orders')
  const edit = page.getByTestId('environment-form')
  await expect(edit.getByLabel('Id', { exact: true })).toBeDisabled()
  await edit.getByLabel('Name', { exact: true }).fill('E2E orders renamed')
  await edit.getByLabel('Max Suite concurrency').fill('2')
  await page.getByTestId('save-environment').click()
  await expect(page.getByTestId('environment-row-e2e-orders')).toContainText('E2E orders renamed')

  // Delete needs a second click.
  await page
    .getByTestId('environment-row-e2e-orders')
    .getByRole('button', { name: /Delete/ })
    .click()
  await expect(page.getByTestId('environment-row-e2e-orders')).toBeVisible()
  await page.getByTestId('confirm-delete').click()
  await expect(page.getByTestId('environment-row-e2e-orders')).toHaveCount(0)
})

test("shows the server's validation problems and enforces Key Vault for PRODUCTION", async ({
  page,
}) => {
  await page.goto('/environments/new')
  const form = page.getByTestId('environment-form')
  await form.getByLabel('Id', { exact: true }).fill('e2e-prod')
  await form.getByLabel('Name', { exact: true }).fill('E2E prod')
  await form.getByTestId('add-target-http').click()
  const target = form.locator('.target-card').last()
  await target.getByLabel('Target name').fill('api')
  await target.getByLabel('Base URL').fill('http://not-secure.example.com')
  await target.getByLabel('Allowed paths (one per line)').fill('/x')
  await page.getByTestId('save-environment').click()
  // Rejected by the server: plain http to a remote host.
  await expect(page.getByTestId('problem-issues')).toContainText('baseUrl')
  await expect(page).toHaveURL(/\/environments\/new$/)

  // PRODUCTION does not accept a local plain-text secret.
  await form.getByLabel('Classification').selectOption('PRODUCTION')
  await expect(page.getByTestId('classification-note')).toContainText('Key Vault')
  await target.getByLabel('Base URL').fill('https://api.example.com')
  await expect(target.getByRole('option', { name: 'Local plain text' })).toBeDisabled()
  await form.getByLabel('Classification').selectOption('TEST')
  await target.getByLabel('Source').selectOption('localPlainText')
  await target.getByLabel('Secret name', { exact: true }).fill('e2e-api-key')
  await form.getByLabel('Classification').selectOption('PRODUCTION')
  await expect(target).toContainText('requires Key Vault')
  await page.getByTestId('save-environment').click()
  await expect(page.getByRole('alert').filter({ hasText: 'must use Key Vault' })).toBeVisible()
  await expect(page).toHaveURL(/\/environments\/new$/)
})

test('local secrets are write-only: set, replace, remove, never shown again', async ({
  page,
  request,
}) => {
  // An Environment that references a local secret by name.
  const list = await (await request.get(`${API}/environment-configs`)).json()
  await request.post(`${API}/environment-configs`, {
    headers: ORIGIN,
    data: {
      revision: list.revision,
      environment: {
        id: 'e2e-secret-user',
        name: 'E2E secret user',
        classification: 'TEST',
        targets: {
          api: {
            kind: 'http',
            baseUrl: 'https://api.example.com',
            allowedPaths: ['/x'],
            authentication: {
              type: 'secretReference',
              provider: 'localPlainText',
              name: 'e2e-api-key',
            },
          },
          vault: {
            kind: 'azureServiceBus',
            fullyQualifiedNamespace: 'example.servicebus.windows.net',
            allowedEntities: ['q'],
            credential: {
              type: 'secretReference',
              provider: 'keyVault',
              name: 'e2e-bus-connection',
              usage: 'connectionString',
            },
          },
        },
      },
    },
  })

  await page.goto('/secrets')
  await expect(page.getByTestId('secrets-note')).toContainText('write-only')
  const row = page.getByTestId('secret-row-e2e-api-key')
  await expect(row).toContainText('Not set')
  await expect(row).toContainText('e2e-secret-user / api')

  // Key Vault references are shown as references only.
  const vault = page.getByTestId('key-vault-references')
  await expect(vault).toContainText('e2e-bus-connection')
  await expect(vault.getByTestId('vault-status')).toContainText('not configured')

  await row.getByTestId('edit-secret-e2e-api-key').click()
  const input = page.getByLabel(/New value for/)
  await expect(input).toHaveAttribute('type', 'password')
  await input.fill(SECRET_VALUE)
  await page.getByTestId('save-edit').click()
  await expect(row).toContainText('Set')
  await expect(row.getByText('Not set')).toHaveCount(0)

  // Nothing on the page, and nothing the API returns, contains the value.
  await page.reload()
  await expect(page.getByTestId('secret-row-e2e-api-key')).toContainText('Set')
  expect(await page.content()).not.toContain(SECRET_VALUE)
  const overview = await request.get(`${API}/secrets`)
  expect(await overview.text()).not.toContain(SECRET_VALUE)

  // The Environment editor reports it as set.
  await page.goto('/environments/e2e-secret-user')
  await expect(page.getByTestId('secret-ref-api')).toContainText('Set')

  // Replace, then remove with a second click.
  await page.goto('/secrets')
  await page.getByTestId('edit-secret-e2e-api-key').click()
  await page.getByLabel(/New value for/).fill('another-test-value-9876543210')
  await page.getByTestId('save-edit').click()
  await expect(page.getByTestId('edit-row-e2e-api-key')).toHaveCount(0)
  await page
    .getByTestId('secret-row-e2e-api-key')
    .getByRole('button', { name: /Remove e2e-api-key/ })
    .click()
  await page.getByTestId('confirm-remove-secret').click()
  await expect(page.getByTestId('secret-row-e2e-api-key')).toContainText('Not set')
})

test('the Test editor links to the Environments page', async ({ page }) => {
  await page.goto('/tests/new')
  await page.getByTestId('manage-environments').click()
  await expect(page).toHaveURL(/\/environments$/)
})

test('Configuration appears in the navigation', async ({ page }) => {
  await page.goto('/')
  const nav = page.getByTestId('side-nav')
  await expect(nav.getByText('Configuration', { exact: true })).toBeVisible()
  await nav.getByRole('link', { name: 'Environments' }).click()
  await expect(page).toHaveURL(/\/environments$/)
  await nav.getByRole('link', { name: 'Secrets' }).click()
  await expect(page).toHaveURL(/\/secrets$/)
})
