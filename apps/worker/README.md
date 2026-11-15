# Worker

Independent process that claims queued jobs from the shared SQLite database and executes functional Test Runs sequentially. It serves only `/health/live` and `/health/ready` (bound to 127.0.0.1) and never imports `apps/api`.

Allowed dependencies: `contracts`, `core`, `step-sdk`, and `infrastructure-local`.

```powershell
pnpm --filter @test-platform/worker dev    # build + run, reads ../../.env
pnpm --filter @test-platform/worker test
```

## Behaviour

- **Claim**: `jobs.claim` leases one job (default 30 s) and a renewer extends it every third of the lease. An expired-lease sweep (`recoverExpired`) runs at startup and every `WORKER_REAPER_MS`.
- **Snapshots only**: the Run's embedded snapshots (Test, Test Data, Environment) are executed. Definition files are never read.
- **Run states**: `Queued → Running → Succeeded | Failed`, or `Running → Cancelling → Cancelled`. Terminal Run events are published _before_ the terminal transition.
- **Step runs**: one row per attempt. A failed attempt that will be retried ends as `Retrying`; the final failure is `Failed`; cancellation ends the open attempt as `Cancelled`.
- **Cancellation**: checked before every Step, polled while a Step runs (`WORKER_CANCEL_POLL_MS`), and honoured during delays and retry backoff.
- **Restart**: a Run found `Running` is resumed. Succeeded Steps are reused (full output recovered from the `step-output` artifact when the stored preview was truncated); an attempt that was `Running` is marked `Failed` (`EXECUTION_LEASE`) and replayed as the next attempt. A Step with `capabilities.external` is replayed only if its retry policy grants another attempt, because target operations are not assumed idempotent.
- **Shutdown**: stops claiming, waits `WORKER_SHUTDOWN_GRACE_MS` for the active Run, then interrupts it and returns the job to the queue. A lost lease makes the worker stop writing for that Run.
- **Limits**: Step timeout is `min(node timeout, Environment maxStepTimeoutSeconds)`; persisted inputs, outputs and logs are capped at `maxPayloadCaptureBytes`.

## Configuration

All variables are prefixed `TEST_PLATFORM_`.

| Variable                                         | Default               | Meaning                                    |
| ------------------------------------------------ | --------------------- | ------------------------------------------ |
| `RUNTIME_DIR` / `DEFINITIONS_DIR` / `CONFIG_DIR` | `./runtime` …         | Shared with the API                        |
| `LOG_LEVEL`                                      | `info`                | `debug`, `info`, `warn`, `error`           |
| `SECRET_<NAME>`                                  | -                     | Secret values, masked everywhere persisted |
| `MAX_ARTIFACT_BYTES`                             | store default (50 MB) | Artifact size cap                          |
| `WORKER_ID`                                      | host-pid-random       | Lease owner identity                       |
| `WORKER_HEALTH_PORT`                             | `3001`                | Health listener port (`0` = ephemeral)     |
| `WORKER_POLL_MS`                                 | `1000`                | Idle sleep between claims                  |
| `WORKER_LEASE_MS`                                | `30000`               | Job lease duration                         |
| `WORKER_LEASE_RENEW_MS`                          | lease / 3             | Renewal interval (< lease)                 |
| `WORKER_REAPER_MS`                               | `10000`               | Minimum gap between expired-lease sweeps   |
| `WORKER_CANCEL_POLL_MS`                          | `500`                 | Cancellation poll while a Step runs        |
| `WORKER_SHUTDOWN_GRACE_MS`                       | `10000`               | Wait for the active Run on shutdown        |
| `WORKER_DEFAULT_STEP_TIMEOUT_SECONDS`            | `300`                 | When a node sets no timeout                |
| `WORKER_PAYLOAD_CAPTURE_BYTES`                   | `65536`               | When the Environment sets no cap           |
