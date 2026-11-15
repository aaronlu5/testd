import { defineConfig, devices } from '@playwright/test'

const PORT = 4173
const API_PORT = 3100

export default defineConfig({
  testDir: './e2e',
  // Tests share one API, worker and database.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
  },
  // Set E2E_BROWSER_CHANNEL=chrome to use an installed Chrome instead of Playwright's Chromium.
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: process.env.E2E_BROWSER_CHANNEL },
    },
  ],
  webServer: [
    {
      command: 'node e2e/backend.mjs',
      url: `http://127.0.0.1:${API_PORT}/health/live`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `pnpm exec vite --host 127.0.0.1 --port ${PORT} --strictPort`,
      url: `http://127.0.0.1:${PORT}`,
      reuseExistingServer: !process.env.CI,
      env: { VITE_API_BASE_URL: `http://127.0.0.1:${API_PORT}` },
    },
  ],
})
