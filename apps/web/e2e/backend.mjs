// Starts the real API and worker against a throwaway runtime directory for end-to-end tests.
// Requires `pnpm build` so apps/api/dist and apps/worker/dist exist.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const base = join(here, '.runtime')
const api = join(root, 'apps/api/dist/server.js')
const worker = join(root, 'apps/worker/dist/main.js')

for (const file of [api, worker]) {
  if (!existsSync(file)) {
    console.error(`Missing ${file}. Run "pnpm build" first.`)
    process.exit(1)
  }
}

rmSync(base, { recursive: true, force: true })
mkdirSync(join(base, 'config'), { recursive: true })
writeFileSync(
  join(base, 'config', 'environments.local.json'),
  JSON.stringify({
    environments: [
      {
        id: 'local-test',
        name: 'Local test',
        classification: 'TEST',
        limits: { maxStepTimeoutSeconds: 60, maxRetryAttempts: 3, maxSuiteConcurrency: 2 },
        values: { region: 'eu' },
        targets: {
          // Never contacted: the inspector poll interval below is far longer than any test.
          bus: {
            kind: 'azureServiceBus',
            fullyQualifiedNamespace: 'e2e-bus.invalid',
            allowedEntities: ['orders', 'events'],
            allowedOperations: ['send', 'inspect'],
          },
        },
      },
    ],
  }),
)

const env = {
  ...process.env,
  TEST_PLATFORM_RUNTIME_DIR: join(base, 'runtime'),
  TEST_PLATFORM_DEFINITIONS_DIR: join(base, 'definitions'),
  TEST_PLATFORM_CONFIG_DIR: join(base, 'config'),
  TEST_PLATFORM_API_PORT: '3100',
  TEST_PLATFORM_API_CORS_ORIGINS: 'http://127.0.0.1:4173',
  TEST_PLATFORM_WORKER_HEALTH_PORT: '3101',
  TEST_PLATFORM_MOCK_API_PORT: '3102',
  TEST_PLATFORM_WORKER_POLL_MS: '100',
  TEST_PLATFORM_LOG_LEVEL: 'warn',
  TEST_PLATFORM_INSPECTOR_POLL_MS: '300000',
}

const children = [api, worker].map((file) =>
  spawn(process.execPath, [file], { env, stdio: 'inherit' }),
)

const stop = () => {
  for (const child of children) child.kill()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
for (const child of children) child.on('exit', (code) => code && process.exit(code))
