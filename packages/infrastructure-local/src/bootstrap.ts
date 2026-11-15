import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createRedactor,
  systemClock,
  type Clock,
  type Logger,
  type Redactor,
} from '@test-platform/core';
import { FileArtifactStore } from './artifacts/file-artifact-store.js';
import { LocalDefinitionRepository } from './definitions/local-definition-repository.js';
import { createJsonLogger, type LogSink } from './logging/json-logger.js';
import {
  AzureKeyVaultSecretProvider,
  type KeyVaultClientFactory,
} from './secrets/key-vault-provider.js';
import { ChainedSecretProvider } from './secrets/chained-secret-provider.js';
import { LocalSecretsStore } from './secrets/local-secrets-store.js';
import { LocalPlainTextSecretProvider } from './secrets/local-plain-text-provider.js';
import { SqliteAssetIndex } from './sqlite/asset-index.js';
import { SqliteAuditLog, SqliteRunEvents } from './sqlite/audit-and-events.js';
import { openDatabase, type Database } from './sqlite/database.js';
import { SqliteJobQueue } from './sqlite/job-queue.js';
import { migrate, type MigrationResult } from './sqlite/migrator.js';
import { SqliteRunPauseRepository } from './sqlite/run-pause-repository.js';
import { SqliteRunRepository } from './sqlite/run-repository.js';
import { SqliteSuiteRunCommands } from './sqlite/suite-run-commands.js';
import { SqliteSuiteRunRepository } from './sqlite/suite-run-repository.js';
import { SqliteInspectorRepository } from './sqlite/inspector-repository.js';
import { SqliteMockApiLog } from './sqlite/mock-api-log.js';
import { SqliteRunCommands } from './sqlite/run-commands.js';
import type { LogLevel } from '@test-platform/contracts';

export type LocalInfrastructureOptions = {
  runtimeDir: string;
  definitionsDir: string;
  env?: Record<string, string | undefined>;
  clock?: Clock;
  logLevel?: LogLevel;
  logSink?: LogSink;
  maxArtifactBytes?: number;
  /** Service Bus Inspector: oldest messages are dropped beyond this many (default 10000). */
  inspectorMaxMessages?: number;
  /**
   * Optional local plain-text secrets file. Defaults to `<runtimeDir>/secrets.local.json`, which
   * is used only if it exists and is Git-ignored.
   */
  secretsFile?: string;
  /** Vault for bare Key Vault secret names; defaults to `TEST_PLATFORM_KEY_VAULT_URL`. */
  keyVaultUrl?: string;
  /** Test seam: replaces the DefaultAzureCredential client. */
  keyVaultClientFactory?: KeyVaultClientFactory;
};

export type LocalInfrastructure = {
  db: Database;
  migration: MigrationResult;
  definitions: LocalDefinitionRepository;
  runs: SqliteRunRepository;
  pauses: SqliteRunPauseRepository;
  suiteRuns: SqliteSuiteRunRepository;
  inspector: SqliteInspectorRepository;
  mockApi: SqliteMockApiLog;
  suiteCommands: SqliteSuiteRunCommands;
  jobs: SqliteJobQueue;
  commands: SqliteRunCommands;
  artifacts: FileArtifactStore;
  events: SqliteRunEvents;
  audit: SqliteAuditLog;
  secrets: ChainedSecretProvider;
  /** Management access to the local plain-text secrets file (write-only for values). */
  localSecrets: LocalSecretsStore;
  redactor: Redactor;
  logger: Logger;
  close(): void;
};

/**
 * Creates missing directories, opens SQLite (WAL), applies migrations, and wires the adapters.
 * Callers run `definitions.reconcile()` once the process is ready to serve.
 */
export const openLocalInfrastructure = (
  options: LocalInfrastructureOptions,
): LocalInfrastructure => {
  const runtimeDir = resolve(options.runtimeDir);
  const definitionsDir = resolve(options.definitionsDir);
  const clock = options.clock ?? systemClock;

  const artifactsDir = join(runtimeDir, 'artifacts');
  for (const dir of [
    artifactsDir,
    join(runtimeDir, 'logs'),
    join(definitionsDir, 'tests'),
    join(definitionsDir, 'suites'),
    join(definitionsDir, 'test-data'),
    join(definitionsDir, 'mock-setups'),
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  const db = openDatabase({ path: join(runtimeDir, 'platform.db') });
  let migration: MigrationResult;
  try {
    migration = migrate(db, undefined, () => clock.now());
  } catch (error) {
    db.close();
    throw error;
  }

  // Every reference names its provider; neither is ever used as a fallback for the other.
  const env = options.env ?? process.env;
  const secretsFile = options.secretsFile ?? join(runtimeDir, 'secrets.local.json');
  let secrets: ChainedSecretProvider;
  try {
    secrets = new ChainedSecretProvider([
      new LocalPlainTextSecretProvider({
        env: options.env,
        secretsFile,
      }),
      new AzureKeyVaultSecretProvider({
        defaultVaultUrl: options.keyVaultUrl ?? env.TEST_PLATFORM_KEY_VAULT_URL,
        clientFactory: options.keyVaultClientFactory,
      }),
    ]);
  } catch (error) {
    db.close();
    throw error;
  }
  const redactor = createRedactor({ secretValues: () => secrets.sensitiveValues() });
  const logger = createJsonLogger({
    level: options.logLevel,
    sink: options.logSink,
    clock,
    redactor,
  });
  const index = new SqliteAssetIndex(db);
  let closed = false;
  const runs = new SqliteRunRepository(db);
  const jobs = new SqliteJobQueue(db, clock);
  const events = new SqliteRunEvents(db);
  const audit = new SqliteAuditLog(db, clock, () => secrets.sensitiveValues());
  const pauses = new SqliteRunPauseRepository({ db, jobs, events, audit, clock });
  const suiteRuns = new SqliteSuiteRunRepository(db);
  const inspector = new SqliteInspectorRepository({
    db,
    redactor,
    clock,
    maxMessages: options.inspectorMaxMessages,
  });
  const mockApi = new SqliteMockApiLog({ db, redactor, clock });
  const commands = new SqliteRunCommands({ db, runs, jobs, events, audit, pauses, clock });
  const suiteCommands = new SqliteSuiteRunCommands({
    db,
    suiteRuns,
    runs,
    runCommands: commands,
    events,
    audit,
    clock,
  });

  return {
    db,
    migration,
    definitions: new LocalDefinitionRepository({ definitionsDir, index, clock }),
    runs,
    pauses,
    suiteRuns,
    inspector,
    mockApi,
    jobs,
    commands,
    suiteCommands,
    artifacts: new FileArtifactStore({
      artifactsDir,
      db,
      clock,
      maxBytes: options.maxArtifactBytes,
    }),
    events,
    audit,
    secrets,
    localSecrets: new LocalSecretsStore({
      file: secretsFile,
      env: options.env,
    }),
    redactor,
    logger,
    close: () => {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
};
