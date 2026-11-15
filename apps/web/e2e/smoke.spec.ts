import { expect, test } from '@playwright/test'

test('renders the Phase 1 navigation and the Test library', async ({ page }) => {
  await page.goto('/tests')
  for (const href of ['/tests', '/test-data', '/suites', '/runs']) {
    await expect(page.locator(`a[href="${href}"]`).first()).toBeAttached()
  }
  await expect(page.getByTestId('asset-library')).toBeVisible()
})

test('degrades gracefully when the API is unavailable', async ({ page }) => {
  // Force the readiness call to fail regardless of the running backend.
  await page.route('**/health/ready', (route) => route.abort('connectionrefused'))
  await page.goto('/system/health')
  await expect(page.getByTestId('api-unavailable')).toBeVisible()
})

test('the root URL shows the landing page and the navigation has no template sections', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.getByTestId('home')).toBeVisible()
  await expect(page.getByRole('img', { name: 'Testd' }).first()).toBeAttached()
  await expect(page.getByTestId('home-motto')).not.toBeEmpty()
  await expect(page.getByTestId('home-flow').locator('li')).toHaveCount(5)

  const nav = page.getByTestId('side-nav')
  for (const removed of [
    'Main',
    'Custom Pages',
    'Layouts',
    'Components',
    'Menu Items',
    'Special Menu',
  ]) {
    await expect(nav.getByText(removed, { exact: true })).toHaveCount(0)
  }
  await expect(nav.getByText('Home', { exact: true })).toBeVisible()

  const map = page.getByTestId('home-component-map')
  await expect(map.getByRole('img', { name: /components relate/ })).toBeVisible()
  for (const name of ['Test Data', 'Test', 'Suite', 'Suite Run', 'Run', 'Environment']) {
    await expect(map.getByText(name, { exact: true }).first()).toBeAttached()
  }

  await page.getByTestId('home-step-2').click()
  await expect(page).toHaveURL(/\/tests$/)
})

test('the top bar keeps only search, environment, theme, fullscreen and user', async ({ page }) => {
  await page.goto('/')
  const bar = page.getByTestId('top-bar')
  for (const gone of ['Mega Menu', 'Apps']) {
    await expect(bar.getByText(gone, { exact: true })).toHaveCount(0)
  }
  for (const id of ['theme-menu', 'fullscreen-toggle', 'user-menu', 'quick-search']) {
    await expect(bar.getByTestId(id)).toBeVisible()
  }
})

test('the Variables help panel opens from the question-mark icon', async ({ page }) => {
  await page.goto('/tests/new')
  const panel = page.getByTestId('variables-help-panel')
  await expect(panel).toBeHidden()
  await page.getByTestId('variables-help-button').click()
  await expect(panel).toBeVisible()
  await expect(panel.getByText('When they are resolved')).toBeVisible()
  await expect(panel.getByText('Overriding for one Run')).toBeVisible()
  await panel.getByRole('button', { name: /close/i }).click()
  await expect(panel).toBeHidden()

  // Escape also closes it once focus is inside the panel.
  await page.getByTestId('variables-help-button').click()
  await expect(panel).toBeVisible()
  await panel.getByText('What you enter').click()
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
})
