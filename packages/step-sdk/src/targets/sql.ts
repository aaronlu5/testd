import type { JsonObject, ValidationIssue } from '@test-platform/contracts';
import {
  PlatformError,
  TARGET_LIMITS,
  analyzeSqlStatement,
  assertConnectionStringMatches,
  type SqlPlan,
  type SqlValue,
  type TargetPolicy,
} from '@test-platform/core';
import type { StepDefinition } from '../types.js';
import {
  asTargetError,
  describeCredential,
  gateRetry,
  resolveSecret,
  withClient,
  type Context,
} from './support.js';

export const SQL_QUERY_STEP_TYPE = 'sql.query';
export const SQL_EXECUTE_STEP_TYPE = 'sql.execute';

const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const DEFAULT_MAX_ROWS = 100;
const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_MAX_ROWS_AFFECTED = 1000;

type SqlParameters = Record<string, string | number | boolean | null>;

export type SqlQueryConfig = {
  target: string;
  /** One SELECT statement; values go in `parameters` and are referenced as `@name`. */
  statement: string;
  parameters?: SqlParameters;
  maxRows?: number;
  timeoutSeconds?: number;
};

export type SqlExecuteConfig = {
  target: string;
  /** One INSERT, UPDATE or DELETE statement; values go in `parameters` and are referenced as `@name`. */
  statement: string;
  parameters?: SqlParameters;
  timeoutSeconds?: number;
  /** Roll back instead of committing when the statement affects more rows than this. */
  maxRowsAffected?: number;
  /** Allow a retry after an ambiguous failure; only safe when repeating the statement changes nothing. */
  retrySafe?: boolean;
};

export const planSqlQuery = (config: SqlQueryConfig, policy: TargetPolicy): SqlPlan =>
  policy.sql(config.target, { statement: config.statement, kind: 'query' });

export const planSqlExecute = (config: SqlExecuteConfig, policy: TargetPolicy): SqlPlan =>
  policy.sql(config.target, { statement: config.statement, kind: 'write' });

const parameterIssues = (
  statement: string,
  parameters: SqlParameters | undefined,
  kind: 'query' | 'write',
): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  for (const name of Object.keys(parameters ?? {})) {
    if (!PARAMETER_NAME.test(name))
      issues.push({
        path: `/parameters/${name}`,
        message: 'is not a valid parameter name',
        keyword: 'step-config',
      });
  }
  // Statements that contain expressions are checked again once resolved, inside the worker.
  if (/\$\{|\{\{/.test(statement)) return issues;
  try {
    const { parameters: used } = analyzeSqlStatement(statement, kind);
    const given = new Set(Object.keys(parameters ?? {}));
    for (const name of used)
      if (!given.has(name))
        issues.push({
          path: `/parameters/${name}`,
          message: `is used by the statement as @${name} but is not provided`,
          keyword: 'step-config',
        });
    for (const name of given)
      if (!used.includes(name))
        issues.push({
          path: `/parameters/${name}`,
          message: `is not used by the statement (@${name})`,
          keyword: 'step-config',
        });
  } catch (error) {
    issues.push({
      path: '/statement',
      message: error instanceof PlatformError ? error.message : 'The statement is not valid.',
      keyword: 'target-policy',
    });
  }
  return issues;
};

const targetIssues = (config: { target: string }, context: Parameters<StepDefinition['validate']>[1]) => {
  const issues: ValidationIssue[] = [];
  if (context.targets) {
    try {
      context.targets.resolve(config.target, 'sqlServer');
    } catch (error) {
      issues.push({
        path: '/target',
        message: error instanceof PlatformError ? error.message : 'Unknown target.',
        keyword: 'target-policy',
      });
    }
  }
  return issues;
};

const checkParameters = (plan: SqlPlan, parameters: SqlParameters): void => {
  const given = new Set(Object.keys(parameters));
  for (const name of plan.parameters)
    if (!given.has(name))
      throw new PlatformError(
        'VALIDATION_TARGET_POLICY',
        `The statement uses @${name} but no value was provided for it.`,
      );
  for (const name of given)
    if (!PARAMETER_NAME.test(name) || !plan.parameters.includes(name))
      throw new PlatformError(
        'VALIDATION_TARGET_POLICY',
        `Parameter "${name}" is not valid or is not used by the statement.`,
      );
};

const openClient = async (context: Context, plan: SqlPlan) => {
  const credential = plan.target.credential;
  context.logger.info(`Connecting to SQL Server with ${describeCredential(credential)}`);
  const base = {
    host: plan.host,
    ...(plan.port !== undefined ? { port: plan.port } : {}),
    database: plan.database,
  };
  if (!credential) return context.clients.openSql(base);
  const connectionString = await resolveSecret(context, credential);
  assertConnectionStringMatches('sqlServer', connectionString, plan.host, plan.database);
  return context.clients.openSql({ ...base, connectionString });
};

const boundedTimeoutMs = (seconds: number | undefined): number =>
  Math.min(seconds ?? DEFAULT_TIMEOUT_SECONDS, TARGET_LIMITS.sqlTimeoutSeconds) * 1000;

const sharedProperties = {
  target: {
    type: 'string',
    minLength: 1,
    description: 'Logical SQL Server target from the Environment.',
  },
  parameters: {
    type: 'object',
    additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
    description:
      'Named values for the statement. Reference each as @name in the statement; never build values into the SQL text.',
  },
  timeoutSeconds: {
    type: 'integer',
    minimum: 1,
    maximum: TARGET_LIMITS.sqlTimeoutSeconds,
    description: `Command timeout; defaults to ${DEFAULT_TIMEOUT_SECONDS}.`,
  },
} as const;

export const sqlQueryStep: StepDefinition<SqlQueryConfig> = {
  type: SQL_QUERY_STEP_TYPE,
  displayName: 'SQL Server query',
  description:
    'Runs one parameterized SELECT against an allowlisted SQL Server target and returns the rows. Read-only: INSERT, UPDATE, DELETE, DDL, EXEC and multiple statements are rejected.',
  configSchema: {
    type: 'object',
    required: ['target', 'statement'],
    additionalProperties: false,
    properties: {
      ...sharedProperties,
      statement: {
        type: 'string',
        minLength: 1,
        maxLength: 20000,
        description: 'One SELECT statement, for example: SELECT id, status FROM dbo.Orders WHERE id = @id',
      },
      maxRows: {
        type: 'integer',
        minimum: 1,
        maximum: TARGET_LIMITS.sqlMaxRows,
        description: `Most rows returned; defaults to ${DEFAULT_MAX_ROWS}. Further rows are dropped and "truncated" is true.`,
      },
    },
  },
  sensitivePaths: [],
  defaults: { maxRows: DEFAULT_MAX_ROWS, timeoutSeconds: DEFAULT_TIMEOUT_SECONDS },
  capabilities: { external: true, supportsRetry: true, supportsArtifacts: false },
  validate(config, context) {
    return [
      ...parameterIssues(config.statement, config.parameters, 'query'),
      ...targetIssues(config, context),
    ];
  },
  async execute(context, config) {
    const plan = planSqlQuery(config, context.policy);
    const parameters = config.parameters ?? {};
    checkParameters(plan, parameters);
    const maxRows = Math.min(config.maxRows ?? DEFAULT_MAX_ROWS, TARGET_LIMITS.sqlMaxRows);

    const client = await openClient(context, plan);
    const result = await withClient(client, async (sql) => {
      try {
        return await sql.query({
          statement: config.statement,
          parameters,
          maxRows,
          timeoutMs: boundedTimeoutMs(config.timeoutSeconds),
          signal: context.signal,
        });
      } catch (error) {
        throw asTargetError(error, 'SQL Server query');
      }
    });

    // Keep the output within the inline payload limit by dropping trailing rows.
    let rows = result.rows;
    let truncated = result.truncated;
    while (rows.length > 0 && JSON.stringify(rows).length > context.limits.payloadBytes) {
      rows = rows.slice(0, Math.floor(rows.length / 2));
      truncated = true;
    }
    if (truncated)
      context.logger.warn('The result was truncated; narrow the query or lower the row count.');
    context.logger.info('Query completed', { target: config.target, rows: rows.length });
    const output: JsonObject = {
      target: config.target,
      columns: result.columns,
      rows,
      rowCount: rows.length,
      truncated,
    };
    return { status: 'Succeeded', output, logs: context.logger.entries() };
  },
};

export const sqlExecuteStep: StepDefinition<SqlExecuteConfig> = {
  type: SQL_EXECUTE_STEP_TYPE,
  displayName: 'SQL Server change data',
  description:
    'Runs one parameterized INSERT, UPDATE or DELETE against an allowlisted SQL Server target, in a transaction. The target must list the operation in "allowedOperations"; UPDATE and DELETE need a WHERE clause. A failed statement is not retried unless you opt in with "retrySafe".',
  configSchema: {
    type: 'object',
    required: ['target', 'statement'],
    additionalProperties: false,
    properties: {
      ...sharedProperties,
      statement: {
        type: 'string',
        minLength: 1,
        maxLength: 20000,
        description:
          'One INSERT, UPDATE or DELETE statement, for example: UPDATE dbo.Orders SET status = @status WHERE id = @id',
      },
      maxRowsAffected: {
        type: 'integer',
        minimum: 1,
        description: `The change is rolled back if it would affect more rows; defaults to ${DEFAULT_MAX_ROWS_AFFECTED}.`,
      },
      retrySafe: { type: 'boolean' },
    },
  },
  sensitivePaths: [],
  defaults: {
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    maxRowsAffected: DEFAULT_MAX_ROWS_AFFECTED,
    retrySafe: false,
  },
  capabilities: { external: true, supportsRetry: true, supportsArtifacts: false },
  validate(config, context) {
    return [
      ...parameterIssues(config.statement, config.parameters, 'write'),
      ...targetIssues(config, context),
    ];
  },
  async execute(context, config) {
    const plan = planSqlExecute(config, context.policy);
    const parameters = config.parameters ?? {};
    checkParameters(plan, parameters);
    const retryAllowed = config.retrySafe === true;
    if (!retryAllowed)
      context.logger.warn('A failed change is not retried unless "retrySafe" is set.');

    const client = await openClient(context, plan);
    const { rowsAffected } = await withClient(client, async (sql) => {
      try {
        return await sql.execute({
          statement: config.statement,
          parameters: parameters as Record<string, SqlValue>,
          timeoutMs: boundedTimeoutMs(config.timeoutSeconds),
          signal: context.signal,
          maxRowsAffected: config.maxRowsAffected ?? DEFAULT_MAX_ROWS_AFFECTED,
        });
      } catch (error) {
        throw gateRetry(
          asTargetError(error, `SQL Server ${plan.operation}`),
          retryAllowed,
          'the statement may already have been applied and "retrySafe" is not set.',
        );
      }
    });

    context.logger.info('Statement committed', {
      target: config.target,
      operation: plan.operation,
      rowsAffected,
    });
    const output: JsonObject = {
      target: config.target,
      operation: plan.operation,
      rowsAffected,
    };
    return { status: 'Succeeded', output, logs: context.logger.entries() };
  },
};
