# Testd

Testd is a local-first test orchestration platform for building, running, and inspecting sequential functional tests. It combines a Vue web UI, a Fastify control-plane API, and a worker, with SQLite and files for local persistence.

Testd's goal is to help teams ship AI-generated code with evidence, not optimism. As AI-assisted development makes code changes faster and more frequent, teams need repeatable, timely feedback that important workflows still behave as intended. Testd supports test automation by bringing the steps, test data, environments, and results of functional tests together so teams can execute them repeatedly and investigate failures. By organizing these tests into reusable suites, teams can run regression tests throughout development to detect when a change breaks existing behavior.

The current priority is to make the test orchestration platform fully functional and dependable. Longer term, Testd aims to connect independently established intent—such as business rules and approved examples—to reviewed tests and their execution evidence. AI-assisted test generation is a future direction, not a current feature.

> **Local development only:** Authentication is a placeholder, not a production security boundary. The API accepts loopback connections only. Do not expose the platform or its unauthenticated mock API to an untrusted network.

## Features

- Create tests from ordered steps, manage test data, and inspect run results.
- Pause runs at breakpoints, inspect their state, and resume or cancel them.
- Organize tests into suites and run them with bounded concurrency.
- Configure targets for HTTP/APIM, Azure Blob Storage, Azure Service Bus, and SQL Server.
- Use a mock API helper and peek at configured Service Bus entities with the inspector.
- Manage environments and secret references in the UI, using local plain-text secrets or Azure Key Vault.

## Requirements

- [Node.js](https://nodejs.org/) 24
- [pnpm](https://pnpm.io/installation) 12 (the repository specifies pnpm 12.9.1)
- Optional: Docker with Compose for the containerized local stack

## Getting started

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The development command builds the API, worker, and shared packages, then starts the web app, API, and worker together. Press **Ctrl+C** to stop them. Use `pnpm dev --no-build` only when the existing build is current.

On first startup, `pnpm dev` copies `config/environments.local.example.json` to `config/environments.local.json` if the latter does not exist. The example uses placeholder targets, not live services. Configure an environment under **Configuration > Environments**, then create test data and a test in the UI, run it, and inspect the results.

| Service       | Local address         |
| ------------- | --------------------- |
| Web UI        | http://127.0.0.1:5173 |
| API           | http://127.0.0.1:3000 |
| Worker health | http://127.0.0.1:3001 |
| Mock API      | http://127.0.0.1:3002 |

The mock API is served by the worker when a test or suite uses a mock setup. API and worker readiness are available at `/health/ready` on their respective ports.

### Docker Compose

First copy `config/environments.local.example.json` to `config/environments.local.json` if it does not already exist. For example, on macOS/Linux:

```sh
cp config/environments.local.example.json config/environments.local.json
docker compose up --build
```

In PowerShell, use `Copy-Item config/environments.local.example.json config/environments.local.json` for the copy. Open [http://localhost:8080](http://localhost:8080); use `docker compose ps` to check health and `docker compose down` to stop the stack. The Compose runtime volume retains the database, artifacts, and logs after shutdown. The `definitions` and `config` directories are mounted from the host; on Linux, `definitions` must be writable by the container's user (UID 1000).

Compose binds the web UI and mock API to host loopback by default. See [`docker-compose.yml`](docker-compose.yml) for port and mount settings.

## Configuration and security

- Optional settings are documented in [`.env.example`](.env.example). Copy it to `.env` and edit it as needed; `pnpm dev` loads it automatically.
- Environment targets can be managed under **Configuration > Environments**. Examples are in [`config`](config). Configure real endpoints and allowlists before using external services.
- Local secret references resolve from `TEST_PLATFORM_SECRET_<NAME>` environment variables first, then `runtime/secrets.local.json`. The **Configuration > Secrets** page can manage the local file. It is **unencrypted**; restrict access to the file and the machine.
- Azure Key Vault references require an Azure identity and, for bare secret names, `TEST_PLATFORM_KEY_VAULT_URL`. Staging and production environment classifications require Key Vault rather than local plain-text references; this does not make the platform itself production-ready.
- The Service Bus Inspector stores collected message bodies in the local database. Treat the database, logs, artifacts, backups, and container runtime volume as potentially sensitive.
- Never commit real credentials, local configuration, or runtime data. `.env`, `config/environments.local.json`, and runtime state are Git-ignored, but verify all tracked files and history before publishing.

## Development and checks

Run these commands from the repository root:

```sh
pnpm typecheck
pnpm lint
pnpm format       # check formatting; does not rewrite files
pnpm test
pnpm build
pnpm stack:check  # requires a build; exercises API and worker in a temporary runtime
```

For browser end-to-end tests, build first and install Playwright's Chromium browser, or set `E2E_BROWSER_CHANNEL=chrome` to use an installed Chrome:

```sh
pnpm build
pnpm --filter @test-platform/web exec playwright install chromium
pnpm test:e2e
```

The stack check can also target a running Compose stack; see the usage comments in [`scripts/stack-check.mjs`](scripts/stack-check.mjs). Azure sandbox tests are opt-in and require separately configured Azure resources and credentials.

## Repository layout

| Path                                                             | Purpose                                            |
| ---------------------------------------------------------------- | -------------------------------------------------- |
| [`apps/web`](apps/web)                                           | Vue web application                                |
| [`apps/api`](apps/api)                                           | Fastify control-plane API                          |
| [`apps/worker`](apps/worker)                                     | Step execution and suite scheduling                |
| [`packages/contracts`](packages/contracts)                       | Shared contracts and schemas                       |
| [`packages/core`](packages/core)                                 | Domain rules and ports                             |
| [`packages/step-sdk`](packages/step-sdk)                         | Step contracts and built-in steps                  |
| [`packages/infrastructure-local`](packages/infrastructure-local) | Filesystem, SQLite, and secret adapters            |
| [`config`](config)                                               | Example environment configurations                 |
| [`definitions`](definitions)                                     | Test, suite, test data, and mock setup definitions |
| [`runtime`](runtime)                                             | Local mutable state; contents are Git-ignored      |

## Contributing

Issues and pull requests are welcome. Describe the problem or proposed change, include reproduction steps where applicable, and run the relevant checks above before submitting a pull request. Do not include secrets or sensitive test data in issues, logs, or contributions.

## License

Testd is released under the [MIT License](LICENSE). Third-party notices for the web app are in [`apps/web/THIRD_PARTY_NOTICES.md`](apps/web/THIRD_PARTY_NOTICES.md).
