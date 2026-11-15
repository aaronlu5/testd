import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { LOG_LEVELS, type LogLevel } from '@test-platform/contracts';

export type WorkerConfig = {
  rootDir: string;
  runtimeDir: string;
  definitionsDir: string;
  configDir: string;
  /** Unique lease-owner identity of this process. */
  workerId: string;
  healthPort: number;
  /** Where the Mock API server listens; the API shows the address the SUT should call. */
  mockApiHost: string;
  mockApiPort: number;
  logLevel: LogLevel;
  /** Sleep between claim attempts when the queue is empty. */
  pollIntervalMs: number;
  /** How long a claimed job stays exclusively ours without renewal. */
  leaseMs: number;
  leaseRenewIntervalMs: number;
  /** Minimum time between expired-lease recovery sweeps. */
  reaperIntervalMs: number;
  /** How often a running Step checks whether cancellation was requested. */
  cancelPollMs: number;
  /** How long shutdown waits for the current Run before releasing its job. */
  shutdownGraceMs: number;
  defaultStepTimeoutSeconds: number;
  /** Used when the Environment sets no `maxPayloadCaptureBytes`. */
  defaultPayloadCaptureBytes: number;
  maxArtifactBytes?: number;
  /** Environment configuration file, read by the Service Bus Inspector (never by Runs). */
  environmentsFile: string;
  /** How often the Service Bus Inspector peeks at each watched entity. */
  inspectorPollMs: number;
  /** Oldest inspector messages are dropped beyond this many. */
  inspectorMaxMessages: number;
  /** Environment used for secret lookups; never serialised. */
  env: Record<string, string | undefined>;
};

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** Relative paths resolve against the workspace root so `pnpm --filter` runs behave like root runs. */
export const findWorkspaceRoot = (start: string): string => {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) return resolve(start);
    current = parent;
  }
};

export const loadConfig = (
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): WorkerConfig => {
  const issues: string[] = [];
  const rootDir = findWorkspaceRoot(cwd);
  const read = (name: string): string | undefined => {
    const value = env[`TEST_PLATFORM_${name}`]?.trim();
    return value ? value : undefined;
  };
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = read(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      issues.push(`TEST_PLATFORM_${name} must be an integer between ${min} and ${max}.`);
      return fallback;
    }
    return value;
  };
  const directory = (name: string, fallback: string): string => {
    const value = read(name) ?? fallback;
    return isAbsolute(value) ? resolve(value) : resolve(rootDir, value);
  };

  const logLevel = (read('LOG_LEVEL') ?? 'info') as LogLevel;
  if (!LOG_LEVELS.includes(logLevel))
    issues.push(`TEST_PLATFORM_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}.`);

  const workerId =
    read('WORKER_ID') ?? `worker-${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workerId))
    issues.push('TEST_PLATFORM_WORKER_ID may contain only letters, digits, ".", "_" and "-".');

  const leaseMs = integer('WORKER_LEASE_MS', 30_000, 100, 3_600_000);
  const leaseRenewIntervalMs = integer(
    'WORKER_LEASE_RENEW_MS',
    Math.max(Math.floor(leaseMs / 3), 50),
    10,
    3_600_000,
  );
  if (leaseRenewIntervalMs >= leaseMs)
    issues.push('TEST_PLATFORM_WORKER_LEASE_RENEW_MS must be shorter than the lease.');

  const environmentsName = read('ENVIRONMENTS_FILE') ?? 'environments.local.json';
  if (
    environmentsName.includes('/') ||
    environmentsName.includes('\\') ||
    environmentsName.includes('..')
  )
    issues.push('TEST_PLATFORM_ENVIRONMENTS_FILE must be a file name inside the config directory.');

  const maxArtifact = read('MAX_ARTIFACT_BYTES');
  const config: WorkerConfig = {
    rootDir,
    runtimeDir: directory('RUNTIME_DIR', './runtime'),
    definitionsDir: directory('DEFINITIONS_DIR', './definitions'),
    configDir: directory('CONFIG_DIR', './config'),
    workerId,
    healthPort: integer('WORKER_HEALTH_PORT', 3001, 0, 65535),
    mockApiHost: read('MOCK_API_HOST') ?? '127.0.0.1',
    mockApiPort: integer('MOCK_API_PORT', 3002, 0, 65535),
    logLevel,
    pollIntervalMs: integer('WORKER_POLL_MS', 1_000, 10, 60_000),
    leaseMs,
    leaseRenewIntervalMs,
    reaperIntervalMs: integer('WORKER_REAPER_MS', 10_000, 10, 3_600_000),
    cancelPollMs: integer('WORKER_CANCEL_POLL_MS', 500, 10, 60_000),
    shutdownGraceMs: integer('WORKER_SHUTDOWN_GRACE_MS', 10_000, 0, 600_000),
    defaultStepTimeoutSeconds: integer('WORKER_DEFAULT_STEP_TIMEOUT_SECONDS', 300, 1, 86_400),
    defaultPayloadCaptureBytes: integer('WORKER_PAYLOAD_CAPTURE_BYTES', 65_536, 256, 16_777_216),
    environmentsFile: join(directory('CONFIG_DIR', './config'), environmentsName),
    inspectorPollMs: integer('INSPECTOR_POLL_MS', 5_000, 500, 300_000),
    inspectorMaxMessages: integer('INSPECTOR_MAX_MESSAGES', 10_000, 100, 1_000_000),
    maxArtifactBytes:
      maxArtifact === undefined ? undefined : integer('MAX_ARTIFACT_BYTES', 0, 1, 1_073_741_824),
    env,
  };

  if (issues.length > 0) throw new ConfigError(issues);
  return config;
};
