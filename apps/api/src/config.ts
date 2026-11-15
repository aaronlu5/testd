import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { LOG_LEVELS, type LogLevel } from '@test-platform/contracts';

export type ApiConfig = {
  rootDir: string;
  runtimeDir: string;
  definitionsDir: string;
  configDir: string;
  environmentsFile: string;
  host: string;
  port: number;
  /** Browser origins allowed by CORS and accepted on mutating requests. */
  allowedOrigins: string[];
  logLevel: LogLevel;
  bodyLimitBytes: number;
  ssePollMs: number;
  sseHeartbeatMs: number;
  maxArtifactBytes?: number;
  /** Service Bus Inspector retention cap; must match the worker's. */
  inspectorMaxMessages: number;
  /** The address the SUT calls to reach the Mock API server (served by the worker). */
  mockApiPublicUrl: string;
  authMode: 'local-dev';
  devUser: string;
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

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
export const isLoopbackHost = (host: string): boolean =>
  LOOPBACK_HOSTS.has(host.replace(/^\[|\]$/g, '').toLowerCase());

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
): ApiConfig => {
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

  const runtimeDir = directory('RUNTIME_DIR', './runtime');
  const definitionsDir = directory('DEFINITIONS_DIR', './definitions');
  const configDir = directory('CONFIG_DIR', './config');

  const environmentsName = read('ENVIRONMENTS_FILE') ?? 'environments.local.json';
  if (
    environmentsName.includes('/') ||
    environmentsName.includes('\\') ||
    environmentsName.includes('..')
  ) {
    issues.push('TEST_PLATFORM_ENVIRONMENTS_FILE must be a file name inside the config directory.');
  }

  const host = read('API_HOST') ?? '127.0.0.1';
  if (!isLoopbackHost(host)) {
    if (read('API_ALLOW_REMOTE') !== 'true') {
      issues.push(
        `TEST_PLATFORM_API_HOST "${host}" is not a loopback address; set TEST_PLATFORM_API_ALLOW_REMOTE=true to request network exposure.`,
      );
    }
    issues.push(
      'Network exposure requires authenticated access, which is not implemented; only local-dev authentication exists.',
    );
  }

  const authMode = read('AUTH_MODE') ?? 'local-dev';
  if (authMode !== 'local-dev')
    issues.push(`TEST_PLATFORM_AUTH_MODE "${authMode}" is not supported (only "local-dev").`);

  const port = integer('API_PORT', 3000, 0, 65535);
  const logLevel = (read('LOG_LEVEL') ?? 'info') as LogLevel;
  if (!LOG_LEVELS.includes(logLevel))
    issues.push(`TEST_PLATFORM_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}.`);

  const allowedOrigins = (read('API_CORS_ORIGINS') ?? 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  for (const origin of allowedOrigins) {
    try {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin)
        throw new Error('not an origin');
    } catch {
      issues.push(
        `TEST_PLATFORM_API_CORS_ORIGINS contains "${origin}", which is not a plain http(s) origin.`,
      );
    }
  }

  const mockApiPort = integer('MOCK_API_PORT', 3002, 1, 65535);
  const mockApiPublicUrl = (
    read('MOCK_API_PUBLIC_URL') ?? `http://127.0.0.1:${mockApiPort}`
  ).replace(/\/+$/, '');
  try {
    const url = new URL(mockApiPublicUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      (url.pathname !== '/' && url.pathname !== '')
    )
      throw new Error('not an origin');
  } catch {
    issues.push(
      'TEST_PLATFORM_MOCK_API_PUBLIC_URL must be a plain http(s) address such as http://mock.test:3002.',
    );
  }

  const maxArtifact = read('MAX_ARTIFACT_BYTES');
  const config: ApiConfig = {
    rootDir,
    runtimeDir,
    definitionsDir,
    configDir,
    environmentsFile: join(configDir, environmentsName),
    host,
    port,
    allowedOrigins,
    logLevel,
    bodyLimitBytes: integer('API_BODY_LIMIT_BYTES', 1_048_576, 1024, 10_485_760),
    ssePollMs: integer('API_SSE_POLL_MS', 500, 10, 10_000),
    sseHeartbeatMs: integer('API_SSE_HEARTBEAT_MS', 15_000, 100, 120_000),
    maxArtifactBytes:
      maxArtifact === undefined ? undefined : integer('MAX_ARTIFACT_BYTES', 0, 1, 1_073_741_824),
    inspectorMaxMessages: integer('INSPECTOR_MAX_MESSAGES', 10_000, 100, 1_000_000),
    mockApiPublicUrl,
    authMode: 'local-dev',
    devUser: read('DEV_USER') ?? 'local-dev-user',
    env,
  };

  if (issues.length > 0) throw new ConfigError(issues);
  return config;
};
