// Starts the API, the worker and the web app together for local development.
//   pnpm dev            build the API/worker, then run all three
//   pnpm dev --no-build skip the build (when dist/ is already current)
// Ctrl+C stops everything. Settings come from ./.env (see .env.example).
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const skipBuild = process.argv.includes('--no-build');

const COLORS = { api: '\x1b[36m', worker: '\x1b[35m', web: '\x1b[32m' };
const RESET = '\x1b[0m';

// The API needs an Environment file; start from the committed example when none exists.
const environments = join(root, 'config', 'environments.local.json');
if (!existsSync(environments)) {
  copyFileSync(join(root, 'config', 'environments.local.example.json'), environments);
  console.log('Created config/environments.local.json from the example (edit it to add targets).');
}

if (!skipBuild) {
  console.log('Building shared packages, API and worker…');
  const build = spawnSync(
    'pnpm',
    ['--filter', '@test-platform/api...', '--filter', '@test-platform/worker...', 'run', 'build'],
    { cwd: root, stdio: 'inherit', shell: isWindows },
  );
  if (build.status !== 0) {
    console.error('Build failed; not starting.');
    process.exit(build.status ?? 1);
  }
}

const envFile = '--env-file-if-exists=' + join(root, '.env');
const services = [
  { name: 'api', command: process.execPath, args: [envFile, 'apps/api/dist/server.js'], cwd: root },
  {
    name: 'worker',
    command: process.execPath,
    args: [envFile, 'apps/worker/dist/main.js'],
    cwd: root,
  },
  {
    name: 'web',
    command: process.execPath,
    args: [
      join(root, 'apps', 'web', 'node_modules', 'vite', 'bin', 'vite.js'),
      '--host',
      '127.0.0.1',
      '--strictPort',
    ],
    cwd: join(root, 'apps', 'web'),
  },
];

const children = [];
let stopping = false;

const stopAll = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null || !child.pid) continue;
    if (isWindows)
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 500);
};

const pipe = (name, stream, target) => {
  let pending = '';
  stream.on('data', (chunk) => {
    const lines = (pending + chunk).split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) target.write(`${COLORS[name]}[${name}]${RESET} ${line}\n`);
  });
};

for (const service of services) {
  const child = spawn(service.command, service.args, {
    cwd: service.cwd,
    shell: service.shell ?? false,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  pipe(service.name, child.stdout, process.stdout);
  pipe(service.name, child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (stopping) return;
    console.error(`[${service.name}] exited with code ${code}; stopping the others.`);
    stopAll(code ?? 1);
  });
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

console.log(`
  Web     http://127.0.0.1:5173
  API     http://127.0.0.1:3000   (health: /health/ready)
  Worker  http://127.0.0.1:3001   (health: /health/ready)
  Mock API http://127.0.0.1:3002  (served by the worker while a Test or Suite uses a setup)
  Press Ctrl+C to stop all three.
`);
