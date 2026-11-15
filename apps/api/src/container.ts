import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import {
  collectSecretReferences,
  systemClock,
  type Clock,
  type Redactor,
} from '@test-platform/core';
import {
  loadMigrations,
  openLocalInfrastructure,
  type LocalInfrastructure,
} from '@test-platform/infrastructure-local';
import { StepRegistry, createBuiltInRegistry } from '@test-platform/step-sdk';
import type { ApiConfig } from './config.js';
import { createLocalDevAuth, type AuthProvider } from './security.js';
import { DefinitionService } from './services/definition-service.js';
import { EnvironmentService } from './services/environment-service.js';
import { RunQueryService } from './services/query-service.js';
import { RunService } from './services/run-service.js';
import { EnvironmentConfigService } from './services/environment-config-service.js';
import { InspectorService } from './services/inspector-service.js';
import { SecretsService } from './services/secrets-service.js';
import { SuiteRunService } from './services/suite-run-service.js';
import { ValidationService } from './services/validation-service.js';

export type Container = {
  config: ApiConfig;
  infra: LocalInfrastructure;
  registry: StepRegistry;
  environments: EnvironmentService;
  validation: ValidationService;
  definitions: DefinitionService;
  runs: RunService;
  suiteRuns: SuiteRunService;
  inspector: InspectorService;
  environmentConfigs: EnvironmentConfigService;
  secrets: SecretsService;
  queries: RunQueryService;
  auth: AuthProvider;
  redactor: Redactor;
  clock: Clock;
  startup: { reconcile: { added: number; updated: number; removed: number; invalid: number } };
  close(): void;
};

export type ContainerOverrides = { clock?: Clock; auth?: AuthProvider };

/**
 * Creates directories, opens SQLite and applies migrations, reconciles definition files into the
 * asset index, and registers built-in Step types. Throws if a local dependency is unavailable.
 */
export const createContainer = async (
  config: ApiConfig,
  overrides: ContainerOverrides = {},
): Promise<Container> => {
  const clock = overrides.clock ?? systemClock;
  const infra = openLocalInfrastructure({
    runtimeDir: config.runtimeDir,
    definitionsDir: config.definitionsDir,
    env: config.env,
    clock,
    logLevel: config.logLevel,
    maxArtifactBytes: config.maxArtifactBytes,
    inspectorMaxMessages: config.inspectorMaxMessages,
  });

  try {
    const report = await infra.definitions.reconcile();
    const registry = createBuiltInRegistry();
    const environments = new EnvironmentService(config.environmentsFile);
    const validation = new ValidationService(registry);
    const definitions = new DefinitionService({
      definitions: infra.definitions,
      audit: infra.audit,
      validation,
      clock,
    });

    return {
      config,
      infra,
      registry,
      environments,
      validation,
      definitions,
      runs: new RunService({
        definitions,
        environments,
        validation,
        commands: infra.commands,
        runs: infra.runs,
        pauses: infra.pauses,
        clock,
      }),
      suiteRuns: new SuiteRunService({ definitions, environments, validation, infra, clock }),
      inspector: new InspectorService({
        environments,
        repository: infra.inspector,
        audit: infra.audit,
        clock,
      }),
      environmentConfigs: new EnvironmentConfigService({
        file: config.environmentsFile,
        environments,
        audit: infra.audit,
        clock,
      }),
      secrets: new SecretsService({
        store: infra.localSecrets,
        resolver: infra.secrets,
        environments,
        audit: infra.audit,
        clock,
        fileLabel: 'runtime/secrets.local.json',
      }),
      queries: new RunQueryService(infra.runs, infra.artifacts, infra.events, infra.pauses),
      auth: overrides.auth ?? createLocalDevAuth(config.devUser),
      redactor: infra.redactor,
      clock,
      startup: {
        reconcile: {
          added: report.added.length,
          updated: report.updated.length,
          removed: report.removed.length,
          invalid: report.invalid.length,
        },
      },
      close: () => infra.close(),
    };
  } catch (error) {
    infra.close();
    throw error;
  }
};

/**
 * Secret availability, without reading or returning any value and without contacting Key Vault
 * or any Azure target. Informational: a missing secret degrades the report but does not make the
 * API unready, because only Steps that use it fail.
 */
export type SecretReadiness = {
  providers: { localPlainText: 'configured'; keyVault: 'configured' | 'unconfigured' };
  references: { total: number; available: number; missing: number; unconfigured: number };
  status: 'ok' | 'degraded';
};

export type ReadinessReport = {
  ready: boolean;
  checks: Record<string, 'ok' | 'failed'>;
  secrets?: SecretReadiness;
};

/** Checks every local dependency without exposing paths or error text. */
export const checkReadiness = async (container: Container): Promise<ReadinessReport> => {
  const { config, infra, environments } = container;
  const attempt = async (work: () => Promise<unknown> | unknown): Promise<'ok' | 'failed'> => {
    try {
      await work();
      return 'ok';
    } catch {
      return 'failed';
    }
  };

  const checks: ReadinessReport['checks'] = {
    database: await attempt(() => {
      const row = infra.db
        .prepare('SELECT MAX(version) AS version FROM schema_migrations')
        .get() as { version: number };
      if (row.version !== loadMigrations().length) throw new Error('schema version mismatch');
    }),
    definitions: await attempt(() =>
      Promise.all(
        ['tests', 'test-data', 'suites', 'mock-setups'].map((dir) =>
          access(join(config.definitionsDir, dir), constants.R_OK | constants.W_OK),
        ),
      ),
    ),
    runtime: await attempt(() =>
      Promise.all(
        ['artifacts', 'logs'].map((dir) =>
          access(join(config.runtimeDir, dir), constants.R_OK | constants.W_OK),
        ),
      ),
    ),
    environments: (await environments.check()) ? 'ok' : 'failed',
  };
  const secrets = await secretReadiness(container).catch(() => undefined);
  return { ready: Object.values(checks).every((value) => value === 'ok'), checks, secrets };
};

const secretReadiness = async (container: Container): Promise<SecretReadiness | undefined> => {
  const { infra, environments } = container;
  let configs;
  try {
    configs = await environments.listConfigs();
  } catch {
    return undefined; // the environments check already reports this
  }
  const counts = { total: 0, available: 0, missing: 0, unconfigured: 0 };
  for (const environment of configs) {
    for (const { reference } of collectSecretReferences(environment)) {
      counts.total += 1;
      const state = await infra.secrets.checkReadiness(reference);
      if (state === 'available' || state === 'configured') counts.available += 1;
      else if (state === 'missing') counts.missing += 1;
      else counts.unconfigured += 1;
    }
  }
  const keyVault = await infra.secrets.checkReadiness({
    type: 'secretReference',
    provider: 'keyVault',
    name: 'readiness-probe',
  });
  return {
    providers: {
      localPlainText: 'configured',
      keyVault: keyVault === 'configured' ? 'configured' : 'unconfigured',
    },
    references: counts,
    status: counts.missing + counts.unconfigured === 0 ? 'ok' : 'degraded',
  };
};
