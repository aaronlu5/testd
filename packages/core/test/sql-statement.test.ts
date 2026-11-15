import { describe, expect, it } from 'vitest';
import type { EnvironmentConfig } from '@test-platform/contracts';
import {
  analyzeSqlStatement,
  assertConnectionStringMatches,
  createTargetPolicy,
  PlatformError,
} from '../src/index.js';

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof PlatformError ? error.code : 'OTHER';
  }
  return undefined;
};

describe('analyzeSqlStatement', () => {
  it('accepts a parameterized SELECT and reports tables and parameters', () => {
    const result = analyzeSqlStatement(
      'SELECT o.id FROM sales.Orders o JOIN [dbo].[Customers] c ON c.id = o.cid WHERE o.id = @id;',
      'query',
    );
    expect(result.operation).toBe('query');
    expect(result.tables).toEqual([
      { schema: 'sales', name: 'Orders' },
      { schema: 'dbo', name: 'Customers' },
    ]);
    expect(result.parameters).toEqual(['id']);
  });

  it('ignores string literals and CTE names', () => {
    const result = analyzeSqlStatement(
      "WITH recent AS (SELECT id FROM dbo.Orders) SELECT * FROM recent WHERE note = 'DROP; -- x'",
      'query',
    );
    expect(result.tables).toEqual([{ schema: 'dbo', name: 'Orders' }]);
  });

  it.each([
    ['SELECT 1; DROP TABLE dbo.Orders', 'query'],
    ['SELECT * INTO dbo.Copy FROM dbo.Orders', 'query'],
    ['DELETE FROM dbo.Orders', 'query'],
    ['EXEC sp_who', 'query'],
    ['SELECT * FROM OPENROWSET(\'x\')', 'query'],
    ['SELECT 1 -- comment', 'query'],
    ['SELECT @@version', 'query'],
    ['SELECT * FROM other.dbo.Orders', 'query'],
    ['SELECT * FROM srv.other.dbo.Orders', 'query'],
    ['DROP TABLE dbo.Orders', 'write'],
    ['UPDATE dbo.Orders SET status = @s', 'write'],
    ['DELETE FROM dbo.Orders', 'write'],
    ['INSERT dbo.Orders (id) VALUES (1)', 'write'],
    ['SELECT 1', 'write'],
  ] as const)('rejects %s', (statement, kind) => {
    expect(code(() => analyzeSqlStatement(statement, kind, 'orders'))).toBe(
      'VALIDATION_TARGET_POLICY',
    );
  });

  it('classifies INSERT, UPDATE and DELETE', () => {
    expect(
      analyzeSqlStatement('INSERT INTO dbo.Orders (id) VALUES (@id)', 'write').operation,
    ).toBe('insert');
    expect(
      analyzeSqlStatement('UPDATE dbo.Orders SET status = @s WHERE id = @id', 'write').operation,
    ).toBe('update');
    expect(
      analyzeSqlStatement('DELETE FROM dbo.Orders WHERE id = @id', 'write').operation,
    ).toBe('delete');
  });
});

describe('sql target policy', () => {
  const environment = (
    target: Record<string, unknown>,
  ): Pick<EnvironmentConfig, 'id' | 'targets'> => ({
    id: 'e',
    targets: { db: { kind: 'sqlServer', server: 'db.example.com,1433', database: 'orders', ...target } },
  } as never);

  it('is read-only unless operations are listed', () => {
    const policy = createTargetPolicy(environment({}));
    expect(policy.sql('db', { statement: 'SELECT 1', kind: 'query' }).operation).toBe('query');
    expect(
      code(() =>
        policy.sql('db', { statement: 'DELETE FROM dbo.T WHERE id = 1', kind: 'write' }),
      ),
    ).toBe('VALIDATION_TARGET_POLICY');
  });

  it('allows listed write operations and resolves host and port', () => {
    const policy = createTargetPolicy(environment({ allowedOperations: ['query', 'update'] }));
    const plan = policy.sql('db', {
      statement: 'UPDATE dbo.T SET a = @a WHERE id = @id',
      kind: 'write',
    });
    expect(plan).toMatchObject({ operation: 'update', host: 'db.example.com', port: 1433 });
    expect(
      code(() =>
        policy.sql('db', { statement: 'INSERT INTO dbo.T (a) VALUES (@a)', kind: 'write' }),
      ),
    ).toBe('VALIDATION_TARGET_POLICY');
  });

  it('enforces allowed schemas', () => {
    const policy = createTargetPolicy(environment({ allowedSchemas: ['sales'] }));
    expect(
      policy.sql('db', { statement: 'SELECT * FROM sales.Orders', kind: 'query' }).operation,
    ).toBe('query');
    expect(
      code(() => policy.sql('db', { statement: 'SELECT * FROM dbo.Orders', kind: 'query' })),
    ).toBe('VALIDATION_TARGET_POLICY');
  });

  it('binds a connection string to the configured server and database', () => {
    const good = 'Server=tcp:db.example.com,1433;Database=orders;User Id=u;Password=p';
    expect(() =>
      assertConnectionStringMatches('sqlServer', good, 'db.example.com', 'orders'),
    ).not.toThrow();
    expect(code(() => assertConnectionStringMatches('sqlServer', good, 'other.example.com'))).toBe(
      'VALIDATION_TARGET_POLICY',
    );
    expect(
      code(() => assertConnectionStringMatches('sqlServer', good, 'db.example.com', 'other')),
    ).toBe('VALIDATION_TARGET_POLICY');
  });
});
