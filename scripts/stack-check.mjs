/* global fetch */
// End-to-end check of the supported local workflow against a running stack (API + worker).
//
//   node scripts/stack-check.mjs                     spawn API and worker from dist/ in a temp dir
//   node scripts/stack-check.mjs --base-url http://localhost:8080 --restart-worker "docker compose restart worker"
//                                                    check an already running stack (Docker Compose)
//
// Covers: Test Data and Test creation, position-driven reorder with normalized save,
// Delay -> Breakpoint -> Assert (pause inspection, resume), cancellation of a separate paused Run,
// a Suite Run with bounded concurrency, worker restarts (while a Run is paused and while Suite
// children are queued), and masking of a local plain-text secret in API output and logs.
// Needs `pnpm build` for the spawn mode. Uses only loopback ports and test-only values.
import { spawn, execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const externalBase = arg('--base-url');
const restartCommand = arg('--restart-worker');
const SECRET = 'stack-check-secret-0123456789abcdef'; // test-only value
const results = [];
// The Environment under test and its Suite concurrency limit; discovered in external mode.
let ENV_ID = 'stack';
let CONC = 2;

const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (probe, what, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
};

// ---- stack ---------------------------------------------------------------------------------------

let base = externalBase;
let workDir;
const children = new Map();
const logs = [];
let echo;
let echoUrl;

const startProcess = (name, file, env) => {
  const child = spawn(process.execPath, [file], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (d) => logs.push(String(d)));
  children.set(name, { child, file, env });
  return child;
};
const killWorker = async () => {
  const entry = children.get('worker');
  entry.child.kill('SIGKILL'); // a crash, not a graceful stop
  await new Promise((r) => entry.child.once('exit', r));
};
const startWorker = () => {
  const entry = children.get('worker');
  startProcess('worker', entry.file, entry.env);
};
const restartWorker = async () => {
  if (externalBase) {
    if (!restartCommand) throw new Error('--restart-worker is required with --base-url');
    execSync(restartCommand, { cwd: root, stdio: 'inherit' });
    return;
  }
  await killWorker();
  startWorker();
};

const environmentConfig = (echoPort) => ({
  environments: [
    {
      id: 'stack',
      name: 'Stack check',
      classification: 'LOCAL',
      limits: { maxStepTimeoutSeconds: 60, maxRetryAttempts: 2, maxSuiteConcurrency: 2 },
      targets: {
        echo: {
          kind: 'http',
          baseUrl: `http://127.0.0.1:${echoPort}`,
          allowedPaths: ['/echo'],
          authentication: {
            type: 'secretReference',
            provider: 'localPlainText',
            name: 'stack-token',
            usage: 'apiKey',
          },
        },
      },
    },
  ],
});

const startSpawned = async () => {
  workDir = mkdtempSync(join(tmpdir(), 'tp-stack-'));
  mkdirSync(join(workDir, 'config'), { recursive: true });
  // A target that echoes the credential it receives, to prove masking of a leaked secret.
  echo = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ youSent: request.headers['ocp-apim-subscription-key'] ?? null }));
  });
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const echoPort = echo.address().port;
  echoUrl = `http://127.0.0.1:${echoPort}`;
  writeFileSync(
    join(workDir, 'config', 'environments.local.json'),
    JSON.stringify(environmentConfig(echoPort)),
  );
  const port = 3300 + Math.floor(Math.random() * 400);
  const env = {
    ...process.env,
    TEST_PLATFORM_RUNTIME_DIR: join(workDir, 'runtime'),
    TEST_PLATFORM_DEFINITIONS_DIR: join(workDir, 'definitions'),
    TEST_PLATFORM_CONFIG_DIR: join(workDir, 'config'),
    TEST_PLATFORM_API_PORT: String(port),
    TEST_PLATFORM_API_CORS_ORIGINS: 'http://127.0.0.1:5173',
    TEST_PLATFORM_WORKER_HEALTH_PORT: String(port + 1000),
    TEST_PLATFORM_MOCK_API_PORT: String(port + 2000),
    TEST_PLATFORM_WORKER_POLL_MS: '100',
    TEST_PLATFORM_WORKER_LEASE_MS: '3000',
    TEST_PLATFORM_WORKER_LEASE_RENEW_MS: '1000',
    TEST_PLATFORM_WORKER_REAPER_MS: '500',
    TEST_PLATFORM_LOG_LEVEL: 'debug',
    TEST_PLATFORM_SECRET_STACK_TOKEN: SECRET,
  };
  startProcess('api', join(root, 'apps/api/dist/server.js'), env);
  startProcess('worker', join(root, 'apps/worker/dist/main.js'), env);
  base = `http://127.0.0.1:${port}`;
};

// ---- HTTP helpers --------------------------------------------------------------------------------

const call = async (method, path, body) => {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  seen.push(text);
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, json, headers: response.headers };
};
const seen = []; // every API response body, scanned for the secret at the end
const ok = async (method, path, body, expected = [200, 201, 202]) => {
  const r = await call(method, path, body);
  if (!expected.includes(r.status))
    throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.json)}`);
  return r;
};

const step = (id, y, type, parameters) => ({
  id,
  type,
  name: id,
  parameters,
  position: { x: 0, y },
});
const pauseTest = (name, delay = 0.2) => ({
  name,
  editor: { layoutDirection: 'vertical', autoSequenceFromPosition: true },
  nodes: [
    step('wait', 0, 'delay', { durationSeconds: delay }),
    step('inspect', 100, 'breakpoint', { enabled: true, message: 'Review before asserting' }),
    step('verify', 200, 'assert', {
      actual: '{{testData.order.id}}',
      operator: 'equals',
      expected: 'ORD-1',
    }),
  ],
  edges: [],
});
const plainTest = (name, delay) => ({
  name,
  editor: { layoutDirection: 'vertical', autoSequenceFromPosition: true },
  nodes: [
    step('wait', 0, 'delay', { durationSeconds: delay }),
    step('verify', 100, 'assert', {
      actual: '{{testData.order.id}}',
      operator: 'equals',
      expected: 'ORD-1',
    }),
  ],
  edges: [],
});

const startRun = async (testId, dataSetId) =>
  (await ok('POST', '/runs', { testId, dataSetId, environmentId: ENV_ID })).json;
const runOf = async (id) => (await ok('GET', `/runs/${id}`)).json;
const waitRun = (id, statuses, what) =>
  until(
    async () => {
      const run = await runOf(id);
      return statuses.includes(run.status) ? run : undefined;
    },
    what ?? `${id} to be ${statuses.join('/')}`,
  );
const stepCount = (run, nodeId, status) =>
  run.stepRuns.filter((s) => s.nodeId === nodeId && (status ? s.status === status : true)).length;

// ---- scenarios -----------------------------------------------------------------------------------

const scenarioReadiness = async () => {
  const live = await fetch(`${base}/health/ready`);
  const body = await live.json();
  seen.push(JSON.stringify(body));
  check('API readiness reports ready', live.status === 200, JSON.stringify(body));
  check(
    'readiness reports secret references by count only',
    !!body.secrets && !JSON.stringify(body.secrets).includes(SECRET),
  );
};

const scenarioReorder = async (data) => {
  const created = (await ok('POST', '/tests', pauseTest('Reorder me'))).json;
  const edgesBefore = created.edges.map((e) => `${e.from}>${e.to}`);
  check(
    'Test saved with server-generated sequence edges',
    edgesBefore.join() === 'wait>inspect,inspect>verify',
    edgesBefore.join(),
  );

  // Drag "verify" above "wait" and ask the server what a save would do.
  const moved = {
    ...pauseTest('Reorder me'),
    nodes: created.nodes.map((n) => (n.id === 'verify' ? { ...n, position: { x: 0, y: -50 } } : n)),
    edges: created.edges,
  };
  const report = (await ok('POST', `/tests/${created.id}/validate`, { test: moved })).json;
  check(
    'validate previews the reorder without saving',
    report.normalization?.orderChanged === true && report.order.join() === 'verify,wait,inspect',
    JSON.stringify(report.order),
  );
  check(
    'validate leaves the stored Test unchanged',
    (await ok('GET', `/tests/${created.id}`)).json.version === created.version,
  );

  const saved = await call('PUT', `/tests/${created.id}`, { ...moved, version: created.version });
  check(
    'save normalizes edges from positions and warns',
    saved.status === 200 &&
      saved.json.edges.map((e) => `${e.from}>${e.to}`).join() === 'verify>wait,wait>inspect' &&
      /FLOW_ORDER_CHANGED/.test(saved.headers.get('x-platform-warnings') ?? ''),
    `${saved.status} ${saved.headers.get('x-platform-warnings')}`,
  );
  void data;
};

const scenarioPauseResumeCancel = async (data) => {
  const test = (await ok('POST', '/tests', pauseTest('Pause then resume'))).json;
  const run = await startRun(test.id, data.id);
  await waitRun(run.id, ['Paused'], 'Run to pause');
  const inspection = (await ok('GET', `/runs/${run.id}/pause`)).json;
  check(
    'paused Run exposes the next Step and completed Steps',
    inspection.pause.nextNodeId === 'verify' &&
      inspection.completedSteps.some((s) => s.nodeId === 'wait'),
    JSON.stringify(inspection.pause),
  );
  const generation = inspection.pause.continuationGeneration;
  const resumed = await ok('POST', `/runs/${run.id}/resume`, {
    continuationGeneration: generation,
  });
  check('resume is accepted', resumed.status === 202);
  const again = await call('POST', `/runs/${run.id}/resume`, {
    continuationGeneration: generation,
  });
  check(
    'repeating the same resume does not queue a second continuation',
    again.status === 202 && again.json.alreadyResumed === true,
    JSON.stringify(again.json),
  );
  const done = await waitRun(run.id, ['Succeeded', 'Failed'], 'resumed Run to finish');
  check(
    'Delay -> Breakpoint -> Assert Run succeeds after resume',
    done.status === 'Succeeded',
    done.status,
  );
  check(
    'each Step ran exactly once',
    stepCount(done, 'wait', 'Succeeded') === 1 &&
      stepCount(done, 'verify', 'Succeeded') === 1 &&
      stepCount(done, 'inspect') === 1,
  );

  const other = await startRun(test.id, data.id);
  await waitRun(other.id, ['Paused'], 'second Run to pause');
  await ok('POST', `/runs/${other.id}/cancel`);
  const cancelled = await waitRun(other.id, ['Cancelled'], 'paused Run to cancel');
  check(
    'a paused Run can be cancelled and never runs the next Step',
    cancelled.status === 'Cancelled' && stepCount(cancelled, 'verify') === 0,
  );
  const stale = await call('POST', `/runs/${run.id}/resume`);
  check(
    'resuming a Run that is no longer paused is a conflict',
    stale.status === 409,
    String(stale.status),
  );
};

const scenarioRestartWhilePaused = async (data) => {
  const test = (await ok('POST', '/tests', pauseTest('Pause across restart'))).json;
  const run = await startRun(test.id, data.id);
  const paused = await waitRun(run.id, ['Paused'], 'Run to pause');
  await restartWorker();
  await sleep(1500);
  const after = await runOf(run.id);
  check(
    'worker restart leaves a paused Run paused at the same generation',
    after.status === 'Paused' && after.continuationGeneration === paused.continuationGeneration,
    `${after.status}/${after.continuationGeneration}`,
  );
  const gen = (await ok('GET', `/runs/${run.id}/pause`)).json.pause.continuationGeneration;
  await ok('POST', `/runs/${run.id}/resume`, { continuationGeneration: gen });
  await restartWorker(); // crash again while the continuation may be queued or running
  const done = await waitRun(run.id, ['Succeeded', 'Failed'], 'Run to finish after restarts');
  check(
    'Run completes exactly once after restarts',
    done.status === 'Succeeded' &&
      stepCount(done, 'verify', 'Succeeded') === 1 &&
      stepCount(done, 'inspect', 'Succeeded') === 1,
    JSON.stringify(done.stepRuns.map((s) => `${s.nodeId}:${s.status}`)),
  );
};

const sampleConcurrency = async (suiteRunId, limit, onSample) => {
  let max = 0;
  for (;;) {
    const view = (await ok('GET', `/suite-runs/${suiteRunId}`)).json;
    const active = view.items.filter((i) =>
      ['Queued', 'Running', 'Paused', 'Cancelling'].includes(i.status),
    ).length;
    max = Math.max(max, active);
    if (active > limit) return { max, view, over: true };
    if (['Succeeded', 'Failed', 'Cancelled'].includes(view.status))
      return { max, view, over: false };
    if (onSample) await onSample(view);
    await sleep(100);
  }
};

const scenarioSuite = async (data) => {
  const tests = [];
  for (let i = 0; i < 4; i += 1)
    tests.push((await ok('POST', '/tests', pauseTest(`Suite child ${i}`, 0.1))).json);
  const suite = (
    await ok('POST', '/suites', {
      name: 'Stack suite',
      items: tests.map((t) => ({ testId: t.id, dataSetId: data.id })),
    })
  ).json;

  const tooMany = await call('POST', '/suite-runs', {
    suiteId: suite.id,
    environmentId: ENV_ID,
    maxConcurrency: CONC + 1,
  });
  check(
    'a Suite Run above the Environment concurrency limit is refused',
    tooMany.status === 422,
    String(tooMany.status),
  );

  const created = (
    await ok('POST', '/suite-runs', {
      suiteId: suite.id,
      environmentId: ENV_ID,
      maxConcurrency: CONC,
    })
  ).json;
  const resumed = new Set();
  const { max, view, over } = await sampleConcurrency(created.id, CONC, async (current) => {
    for (const item of current.items) {
      if (item.status === 'Paused' && item.runId && !resumed.has(item.runId)) {
        const gen = (await call('GET', `/runs/${item.runId}/pause`)).json?.pause
          ?.continuationGeneration;
        const r = await call(
          'POST',
          `/runs/${item.runId}/resume`,
          gen === undefined ? undefined : { continuationGeneration: gen },
        );
        if (r.status === 202) resumed.add(item.runId);
      }
    }
  });
  check(
    'Suite Run never exceeds its concurrency (paused children hold a slot)',
    !over && max <= CONC && max >= 1,
    `max=${max}`,
  );
  check(
    'Suite Run finishes with every child succeeded',
    view.status === 'Succeeded' && view.items.every((i) => i.status === 'Succeeded'),
    `${view.status} ${view.items.map((i) => i.status).join()}`,
  );
  check('all four children were resumed individually', resumed.size === 4, String(resumed.size));
};

const scenarioSuiteRestart = async (data) => {
  const tests = [];
  for (let i = 0; i < 4; i += 1)
    tests.push((await ok('POST', '/tests', plainTest(`Restart child ${i}`, 1))).json);
  const suite = (
    await ok('POST', '/suites', {
      name: 'Restart suite',
      items: tests.map((t) => ({ testId: t.id, dataSetId: data.id })),
    })
  ).json;
  const created = (
    await ok('POST', '/suite-runs', {
      suiteId: suite.id,
      environmentId: ENV_ID,
      maxConcurrency: CONC,
    })
  ).json;
  await until(
    async () => (await runningOrQueued(created.id)) > 0 || undefined,
    'children to be dispatched',
  );
  await restartWorker();
  const { max, view, over } = await sampleConcurrency(created.id, CONC);
  check(
    'Suite children recover after a worker restart without oversubscription',
    !over && max <= CONC,
    `max=${max}`,
  );
  check('Suite Run completes after the restart', view.status === 'Succeeded', view.status);
  const runs = await Promise.all(view.items.map((i) => runOf(i.runId)));
  check(
    'every child ran its Assert exactly once',
    runs.every((r) => stepCount(r, 'verify', 'Succeeded') === 1),
    runs.map((r) => stepCount(r, 'verify', 'Succeeded')).join(),
  );
};
const runningOrQueued = async (id) =>
  (await ok('GET', `/suite-runs/${id}`)).json.items.filter((i) =>
    ['Queued', 'Running'].includes(i.status),
  ).length;

const scenarioSecret = async (data) => {
  if (externalBase) {
    console.log(
      'SKIP  secret redaction through a leaking target (needs a loopback target; spawn mode only)',
    );
    return;
  }
  const test = (
    await ok('POST', '/tests', {
      name: 'Echo the credential',
      editor: { layoutDirection: 'vertical', autoSequenceFromPosition: true },
      nodes: [step('call', 0, 'http.request', { target: 'echo', path: '/echo' })],
      edges: [],
    })
  ).json;
  const run = await startRun(test.id, data.id);
  const done = await waitRun(run.id, ['Succeeded', 'Failed'], 'echo Run');
  const body = JSON.stringify(done);
  check(
    'the Run succeeded and the credential reached the target',
    done.status === 'Succeeded' && /youSent/.test(body),
    done.status,
  );
  check(
    'the echoed secret is masked in the Run detail',
    !body.includes(SECRET) && body.includes('REDACTED'),
  );
  const events = await fetch(`${base}/api/v1/runs/${run.id}/events`);
  const eventText = await events.text();
  seen.push(eventText);
  check('the secret is absent from the event stream', !eventText.includes(SECRET));

  const inline = await call('POST', '/tests', {
    name: 'Inline secret',
    nodes: [
      step('call', 0, 'azure-conn', {
        target: 'x',
        note: 'Endpoint=sb://x.servicebus.windows.net/;SharedAccessKeyName=a;SharedAccessKey=abcdefghijklmnop1234',
      }),
    ],
    edges: [],
  });
  check(
    'an Azure connection string cannot be saved in a Test',
    inline.status === 422,
    String(inline.status),
  );
  const header = (
    await ok('POST', '/tests', {
      name: 'Literal credential header',
      nodes: [
        step('call', 0, 'http.request', {
          target: 'echo',
          path: '/echo',
          headers: { 'X-Api-Key': 'literal-value-123' },
        }),
      ],
      edges: [],
    })
  ).json;
  const refused = await call('POST', '/runs', {
    testId: header.id,
    dataSetId: data.id,
    environmentId: ENV_ID,
  });
  check(
    'a literal credential header is refused before a Run is created',
    refused.status === 422,
    String(refused.status),
  );
};

// ---- main ----------------------------------------------------------------------------------------

const main = async () => {
  if (!externalBase) await startSpawned();
  try {
    await until(
      async () =>
        (await fetch(`${base}/health/ready`).catch(() => undefined))?.status === 200 || undefined,
      'API and migrations',
      60_000,
    );
    if (externalBase) {
      const wanted = arg('--environment');
      const list = (await ok('GET', '/environments')).json.items;
      const found = wanted ? list.find((e) => e.id === wanted) : list[0];
      if (!found)
        throw new Error(
          `No Environment${wanted ? ` "${wanted}"` : ''} is configured (found: ${list.map((e) => e.id).join(', ') || 'none'}).`,
        );
      ENV_ID = found.id;
      CONC = Math.max(found.suiteConcurrencyLimit, 1);
      console.log(
        `NOTE  using Environment "${ENV_ID}", Suite concurrency limit ${CONC}${CONC < 2 ? ' (set limits.maxSuiteConcurrency to 2 in config/environments.local.json to exercise parallelism)' : ''}`,
      );
    }
    await scenarioReadiness();
    const data = (
      await ok('POST', '/test-data', {
        name: 'Order data',
        tags: ['stack'],
        data: { order: { id: 'ORD-1' } },
      })
    ).json;
    check('Test Data created', !!data.id);
    await scenarioReorder(data);
    await scenarioPauseResumeCancel(data);
    await scenarioRestartWhilePaused(data);
    await scenarioSuite(data);
    await scenarioSuiteRestart(data);
    await scenarioSecret(data);

    const everything = seen.join('\n');
    check('no API response contains the plain-text secret', !everything.includes(SECRET));
    if (!externalBase) {
      const output = logs.join('');
      check('no API/worker log line contains the plain-text secret', !output.includes(SECRET));
      check(
        'logs are structured JSON lines',
        output.split('\n').filter((l) => l.startsWith('{')).length > 10,
      );
    }
  } finally {
    for (const { child } of children.values()) child.kill();
    echo?.close();
    await sleep(500); // let killed processes release their files (Windows)
    if (workDir) {
      try {
        rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        console.log(`NOTE  could not remove ${workDir}`);
      }
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  void echoUrl;
};

main().catch((error) => {
  console.error(`FAIL  ${error.message}`);
  if (!externalBase) console.error(logs.slice(-15).join(''));
  process.exitCode = 1;
  for (const { child } of children.values()) child.kill();
  echo?.close();
});
