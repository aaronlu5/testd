# API

Fastify control-plane service. It validates and stores definitions, snapshots and queues Runs, and reports Run state. It never executes a Step; the worker does.

```powershell
pnpm --filter @test-platform/api dev      # build, then run with ../../.env if present
pnpm --filter @test-platform/api test
```

Copy `config/environments.local.example.json` to `config/environments.local.json` first (the API reports not-ready without it). Configuration variables are listed in the repository `.env.example`.

Boundaries: depends only on `contracts`, `core`, `step-sdk`, and `infrastructure-local`; it must not import worker or frontend modules.

Authentication is a local-development placeholder: every caller on the loopback interface acts as `TEST_PLATFORM_DEV_USER`. The API refuses to bind to a non-loopback address until real authentication exists.
