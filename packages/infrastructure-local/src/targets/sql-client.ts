import sql from 'mssql';
import {
  PlatformError,
  mapTargetFailure,
  type SqlConnection,
  type SqlPort,
  type SqlRow,
  type SqlValue,
} from '@test-platform/core';

/** Driver codes mapped onto the codes `mapTargetFailure` already understands. */
const DRIVER_FAILURES: Record<string, { code: string }> = {
  ETIMEOUT: { code: 'ETIMEDOUT' },
  ETIMEDOUT: { code: 'ETIMEDOUT' },
  ESOCKET: { code: 'ECONNRESET' },
  ECONNCLOSED: { code: 'ECONNRESET' },
};

/**
 * SQL Server messages can quote data and object names, so nothing from the driver's message is
 * propagated: only its code and the SQL error number survive, as `detail`.
 */
const mapSqlFailure = (error: unknown, action: string): PlatformError => {
  if (error instanceof PlatformError) return error;
  const failure = error as { code?: unknown; name?: unknown; number?: unknown } | null;
  if (failure?.name === 'AbortError') return mapTargetFailure(error, action);
  const code = typeof failure?.code === 'string' ? failure.code : undefined;
  const number = typeof failure?.number === 'number' ? failure.number : undefined;
  const detail = [code ? `code=${code}` : '', number !== undefined ? `sqlError=${number}` : '']
    .filter(Boolean)
    .join('; ');
  if (code === 'ELOGIN')
    return new PlatformError(
      'AUTH_CREDENTIAL',
      `${action} failed: could not authenticate to the target.`,
      { detail },
    );
  // 229, 230, 300: permission denied on an object, column or the database.
  if (number === 229 || number === 230 || number === 300)
    return new PlatformError(
      'AUTH_FORBIDDEN',
      `${action} failed: the identity is not permitted to perform this operation.`,
      { detail },
    );
  const mapped = code ? DRIVER_FAILURES[code] : undefined;
  if (mapped) return mapTargetFailure({ code: mapped.code }, action);
  return new PlatformError('TARGET_REQUEST', `${action} failed: the target rejected the request.`, {
    ...(detail ? { detail } : {}),
  });
};

const toRowValue = (value: unknown): string | number | boolean | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  return JSON.stringify(value);
};

const abortError = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' });

export class SdkSqlPort implements SqlPort {
  readonly #connection: SqlConnection;
  #pool: sql.ConnectionPool | undefined;

  constructor(connection: SqlConnection) {
    this.#connection = connection;
  }

  async #connect(timeoutMs: number): Promise<sql.ConnectionPool> {
    if (this.#pool) return this.#pool;
    const { connectionString, host, port, database } = this.#connection;
    // The target's own host and database were already bound to the connection string by the Step.
    const pool = connectionString
      ? new sql.ConnectionPool(`${connectionString};Request Timeout=${timeoutMs}`)
      : new sql.ConnectionPool({
          server: host,
          ...(port !== undefined ? { port } : {}),
          database,
          requestTimeout: timeoutMs,
          connectionTimeout: 15_000,
          authentication: { type: 'azure-active-directory-default', options: {} },
          options: { encrypt: true },
        });
    await pool.connect();
    this.#pool = pool;
    return pool;
  }

  #request(
    target: sql.ConnectionPool | sql.Transaction,
    parameters: Record<string, SqlValue>,
  ): sql.Request {
    const request = new sql.Request(target as sql.ConnectionPool);
    for (const [name, value] of Object.entries(parameters)) request.input(name, value);
    return request;
  }

  async query(input: Parameters<SqlPort['query']>[0]): ReturnType<SqlPort['query']> {
    try {
      const pool = await this.#connect(input.timeoutMs);
      const request = this.#request(pool, input.parameters);
      request.stream = true;
      return await new Promise((resolve, reject) => {
        const rows: SqlRow[] = [];
        let columns: string[] = [];
        let truncated = false;
        const onAbort = (): void => {
          request.cancel();
          reject(abortError());
        };
        const finish = (): void => input.signal.removeEventListener('abort', onAbort);
        if (input.signal.aborted) {
          onAbort();
          return;
        }
        input.signal.addEventListener('abort', onAbort, { once: true });
        request.on('recordset', (meta: Record<string, unknown>) => {
          columns = Object.keys(meta);
        });
        request.on('row', (row: Record<string, unknown>) => {
          if (truncated) return;
          if (rows.length >= input.maxRows) {
            truncated = true;
            request.cancel();
            return;
          }
          rows.push(
            Object.fromEntries(Object.entries(row).map(([key, value]) => [key, toRowValue(value)])),
          );
        });
        request.on('error', (error: unknown) => {
          finish();
          // Cancelling to enforce the row cap surfaces as an error; that is not a failure.
          if (truncated) resolve({ columns, rows, truncated });
          else reject(error);
        });
        request.on('done', () => {
          finish();
          resolve({ columns, rows, truncated });
        });
        void request.query(input.statement);
      });
    } catch (error) {
      throw mapSqlFailure(error, 'SQL Server query');
    }
  }

  async execute(input: Parameters<SqlPort['execute']>[0]): ReturnType<SqlPort['execute']> {
    let transaction: sql.Transaction | undefined;
    try {
      const pool = await this.#connect(input.timeoutMs);
      transaction = new sql.Transaction(pool);
      await transaction.begin();
      const request = this.#request(transaction, input.parameters);
      const onAbort = (): void => request.cancel();
      input.signal.addEventListener('abort', onAbort, { once: true });
      let result: sql.IResult<unknown>;
      try {
        result = await request.query(input.statement);
      } finally {
        input.signal.removeEventListener('abort', onAbort);
      }
      const rowsAffected = result.rowsAffected.reduce((sum, count) => sum + count, 0);
      if (rowsAffected > input.maxRowsAffected) {
        await transaction.rollback();
        transaction = undefined;
        throw new PlatformError(
          'TARGET_REQUEST',
          `The statement would affect ${rowsAffected} rows, more than the limit of ${input.maxRowsAffected}; it was rolled back.`,
        );
      }
      await transaction.commit();
      transaction = undefined;
      return { rowsAffected };
    } catch (error) {
      await transaction?.rollback().catch(() => undefined);
      throw mapSqlFailure(error, 'SQL Server change');
    }
  }

  async close(): Promise<void> {
    await this.#pool?.close().catch(() => undefined);
    this.#pool = undefined;
  }
}
