import { describe, expect, it } from 'vitest';
import type { EnvironmentConfig } from '@test-platform/contracts';
import {
  PlatformError,
  isRetryableCode,
  createTargetPolicy,
  createTargetResolver,
  type SqlPort,
  type TargetClients,
} from '@test-platform/core';
import {
  checkTargetStepPolicy,
  executeStep,
  sqlExecuteStep,
  sqlQueryStep,
  type StepDefinition,
} from '../src/index.js';
import { makeContext } from './helpers.js';

const CONNECTION = 'Server=tcp:db.example.com,1433;Database=orders;User Id=app;Password=s3cret-pw';

const environment: Pick<EnvironmentConfig, 'id' | 'targets'> = {
  id: 'orders-test',
  targets: {
    reader: { kind: 'sqlServer', server: 'db.example.com,1433', database: 'orders' },
    writer: {
      kind: 'sqlServer',
      server: 'db.example.com,1433',
      database: 'orders',
      allowedOperations: ['query', 'insert', 'update', 'delete'],
      credential: { type: 'secretReference', provider: 'localPlainText', name: 'sql-conn' },
    },
  },
};

type Calls = { queries: unknown[]; executes: unknown[]; opened: unknown[]; closed: number };

const setup = (options: { executeError?: unknown; rows?: number } = {}) => {
  const calls: Calls = { queries: [], executes: [], opened: [], closed: 0 };
  const port: SqlPort = {
    query: (input) => {
      calls.queries.push(input);
      const rows = Array.from({ length: options.rows ?? 2 }, (_, id) => ({ id, name: `n${id}` }));
      return Promise.resolve({ columns: ['id', 'name'], rows, truncated: false });
    },
    execute: (input) => {
      calls.executes.push(input);
      return options.executeError
        ? Promise.reject(options.executeError)
        : Promise.resolve({ rowsAffected: 3 });
    },
    close: () => {
      calls.closed += 1;
      return Promise.resolve();
    },
  };
  const clients = {
    ...makeContext().clients,
    openSql: (connection) => {
      calls.opened.push(connection);
      return port;
    },
  } as TargetClients;
  const context = makeContext({
    policy: createTargetPolicy(environment),
    targets: createTargetResolver(environment),
    clients,
    secretReferences: {
      resolve: () => Promise.resolve(CONNECTION),
      checkReadiness: () => Promise.resolve('available'),
      sensitiveValues: () => [],
    },
  });
  return { calls, context };
};

const run = async (
  definition: StepDefinition<never>,
  config: unknown,
  context: ReturnType<typeof setup>['context'],
) =>
  (
    await executeStep(definition as StepDefinition<unknown>, config as never, context, {
      timeoutMs: 5000,
    })
  ).result;

describe('sql.query', () => {
  it('returns rows and passes parameters to the client', async () => {
    const { calls, context } = setup();
    const result = await run(
      sqlQueryStep as never,
      { target: 'reader', statement: 'SELECT id, name FROM dbo.T WHERE id = @id', parameters: { id: 7 } },
      context,
    );
    expect(result.status).toBe('Succeeded');
    expect(result.output).toMatchObject({ rowCount: 2, columns: ['id', 'name'], truncated: false });
    expect(calls.queries[0]).toMatchObject({ parameters: { id: 7 }, maxRows: 100 });
    expect(calls.opened[0]).toEqual({ host: 'db.example.com', port: 1433, database: 'orders' });
    expect(calls.closed).toBe(1);
  });

  it('refuses a statement that changes data, before opening a connection', async () => {
    const { calls, context } = setup();
    const result = await run(
      sqlQueryStep as never,
      { target: 'reader', statement: 'DELETE FROM dbo.T WHERE id = 1' },
      context,
    );
    expect(result.status).toBe('Failed');
    expect(calls.opened).toHaveLength(0);
  });

  it('fails when a parameter is missing', async () => {
    const { calls, context } = setup();
    const result = await run(
      sqlQueryStep as never,
      { target: 'reader', statement: 'SELECT 1 FROM dbo.T WHERE id = @id' },
      context,
    );
    expect(result.status).toBe('Failed');
    expect(calls.opened).toHaveLength(0);
  });

  it('truncates output that exceeds the payload limit', async () => {
    const { context } = setup({ rows: 5000 });
    const result = await run(
      sqlQueryStep as never,
      { target: 'reader', statement: 'SELECT id, name FROM dbo.T', maxRows: 1000 },
      { ...context, limits: { payloadBytes: 2000, transferBytes: 1_000_000 } },
    );
    expect(result.status).toBe('Succeeded');
    expect((result.output as { truncated: boolean }).truncated).toBe(true);
    expect(JSON.stringify(result.output).length).toBeLessThan(3000);
  });
});

describe('sql.execute', () => {
  it('is blocked on a read-only target', async () => {
    const { calls, context } = setup();
    const result = await run(
      sqlExecuteStep as never,
      { target: 'reader', statement: 'DELETE FROM dbo.T WHERE id = @id', parameters: { id: 1 } },
      context,
    );
    expect(result.status).toBe('Failed');
    expect(calls.opened).toHaveLength(0);
  });

  it('runs an allowed statement using the resolved connection string', async () => {
    const { calls, context } = setup();
    const result = await run(
      sqlExecuteStep as never,
      {
        target: 'writer',
        statement: 'UPDATE dbo.T SET name = @name WHERE id = @id',
        parameters: { name: 'x', id: 1 },
      },
      context,
    );
    expect(result.status).toBe('Succeeded');
    expect(result.output).toMatchObject({ operation: 'update', rowsAffected: 3 });
    expect(calls.opened[0]).toMatchObject({ connectionString: CONNECTION });
    expect(JSON.stringify(result)).not.toContain('s3cret-pw');
  });

  it('does not retry an ambiguous failure unless retrySafe is set', async () => {
    const failure = new PlatformError('TARGET_TIMEOUT', 'timed out');
    const config = {
      target: 'writer',
      statement: 'INSERT INTO dbo.T (a) VALUES (@a)',
      parameters: { a: 1 },
    };
    const unsafe = await run(sqlExecuteStep as never, config, setup({ executeError: failure }).context);
    expect(unsafe.status).toBe('Failed');
    expect(isRetryableCode(unsafe.error!.code)).toBe(false);
    const safe = await run(
      sqlExecuteStep as never,
      { ...config, retrySafe: true },
      setup({ executeError: failure }).context,
    );
    expect(isRetryableCode(safe.error!.code)).toBe(true);
  });
});

describe('sql target policy check', () => {
  it('rejects a literal write Step against a read-only target', () => {
    const policy = createTargetPolicy(environment);
    const issues = checkTargetStepPolicy(
      'sql.execute',
      { target: 'reader', statement: 'DELETE FROM dbo.T WHERE id = @id', parameters: { id: 1 } },
      policy,
    );
    expect(issues).toHaveLength(1);
    expect(checkTargetStepPolicy('sql.query', { target: 'reader', statement: 'SELECT 1' }, policy)).toEqual([]);
  });
});
