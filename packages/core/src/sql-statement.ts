import { PlatformError } from './errors.js';

/**
 * Static checks for the single SQL statement a SQL Server Step may send. This is a guard rail,
 * not a SQL parser: it keeps Tests inside "one statement, one kind of operation, allowed schemas"
 * so a mistake or a pasted script cannot drop a table or reach another database. The database
 * login used by the target remains the real security boundary and should be least-privilege.
 */

export type SqlOperation = 'query' | 'insert' | 'update' | 'delete';
export const SQL_OPERATIONS: readonly SqlOperation[] = ['query', 'insert', 'update', 'delete'];

export type SqlTableReference = { schema: string; name: string };

export type SqlStatementAnalysis = {
  operation: SqlOperation;
  tables: SqlTableReference[];
  /** Parameter names (without `@`) the statement references. */
  parameters: string[];
};

type Token = { type: 'word' | 'ident' | 'symbol'; value: string };

const policyError = (message: string): PlatformError =>
  new PlatformError('VALIDATION_TARGET_POLICY', message);

const DEFAULT_SCHEMA = 'dbo';
const WORD_START = /[A-Za-z_#@\u0080-￿]/;
const WORD_CHAR = /[A-Za-z0-9_#@$\u0080-￿]/;

/** Keywords no Step statement may contain, whatever its kind. */
const ALWAYS_FORBIDDEN = new Set([
  'ALTER',
  'BACKUP',
  'BULK',
  'CREATE',
  'DBCC',
  'DECLARE',
  'DENY',
  'DROP',
  'EXEC',
  'EXECUTE',
  'GRANT',
  'KILL',
  'OPENDATASOURCE',
  'OPENQUERY',
  'OPENROWSET',
  'RESTORE',
  'REVOKE',
  'SHUTDOWN',
  'TRUNCATE',
  'USE',
  'WAITFOR',
]);

const DML_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);

/** Words that can follow a table name and are therefore not an alias. */
const NOT_AN_ALIAS = new Set([
  'WHERE',
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'CROSS',
  'OUTER',
  'ON',
  'GROUP',
  'ORDER',
  'HAVING',
  'UNION',
  'EXCEPT',
  'INTERSECT',
  'WITH',
  'OPTION',
  'SET',
  'VALUES',
  'SELECT',
  'OUTPUT',
  'FOR',
  'OFFSET',
  'FETCH',
]);

/** Splits a statement into words, bracketed/quoted identifiers and symbols; literals and comments vanish. */
const tokenize = (sql: string): Token[] => {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const char = sql.charAt(i);
    if (/\s/.test(char)) {
      i += 1;
    } else if (sql.startsWith('--', i)) {
      throw policyError('SQL comments are not allowed in a Step statement.');
    } else if (sql.startsWith('/*', i)) {
      throw policyError('SQL comments are not allowed in a Step statement.');
    } else if (char === "'") {
      // String literal ('' escapes a quote); its content is data, never code.
      i += 1;
      for (;;) {
        if (i >= sql.length) throw policyError('The statement has an unterminated string literal.');
        if (sql.charAt(i) === "'") {
          if (sql.charAt(i + 1) === "'") i += 2;
          else break;
        } else i += 1;
      }
      i += 1;
      tokens.push({ type: 'symbol', value: "'" });
    } else if (char === '[' || char === '"') {
      const close = char === '[' ? ']' : '"';
      let value = '';
      i += 1;
      for (;;) {
        if (i >= sql.length) throw policyError('The statement has an unterminated identifier.');
        if (sql.charAt(i) === close) {
          if (sql.charAt(i + 1) === close) {
            value += close;
            i += 2;
          } else break;
        } else {
          value += sql.charAt(i);
          i += 1;
        }
      }
      i += 1;
      tokens.push({ type: 'ident', value });
    } else if (WORD_START.test(char)) {
      let end = i + 1;
      while (end < sql.length && WORD_CHAR.test(sql.charAt(end))) end += 1;
      tokens.push({ type: 'word', value: sql.slice(i, end) });
      i = end;
    } else if (/[0-9]/.test(char)) {
      let end = i + 1;
      while (end < sql.length && /[0-9A-Za-z_.]/.test(sql.charAt(end))) end += 1;
      tokens.push({ type: 'symbol', value: '0' });
      i = end;
    } else {
      tokens.push({ type: 'symbol', value: char });
      i += 1;
    }
  }
  return tokens;
};

const upper = (token: Token | undefined): string | undefined =>
  token?.type === 'word' ? token.value.toUpperCase() : undefined;

const isSymbol = (token: Token | undefined, value: string): boolean =>
  token?.type === 'symbol' && token.value === value;

/** Reads `a.b.c` starting at `start`; returns the parts and the index after the name. */
const readName = (tokens: Token[], start: number): { parts: string[]; next: number } => {
  const parts: string[] = [];
  let index = start;
  for (;;) {
    const token = tokens[index];
    if (!token || token.type === 'symbol') break;
    parts.push(token.value);
    index += 1;
    if (isSymbol(tokens[index], '.')) index += 1;
    else break;
  }
  return { parts, next: index };
};

export const analyzeSqlStatement = (
  statement: string,
  expectedOperation: 'query' | 'write',
  database?: string,
): SqlStatementAnalysis => {
  const text = statement.trim().replace(/;\s*$/, '');
  if (text === '') throw policyError('The SQL statement is empty.');
  if (text.length > 20_000) throw policyError('The SQL statement is longer than 20000 characters.');
  const tokens = tokenize(text);
  if (tokens.some((token) => isSymbol(token, ';')))
    throw policyError('Only one SQL statement is allowed; remove the ";" separators.');

  const first = upper(tokens[0]);
  let operation: SqlOperation;
  if (expectedOperation === 'query') {
    if (first !== 'SELECT' && first !== 'WITH')
      throw policyError('A query must start with SELECT (or WITH).');
    operation = 'query';
  } else {
    if (first === 'INSERT') {
      if (upper(tokens[1]) !== 'INTO') throw policyError('Write "INSERT INTO <table>".');
      operation = 'insert';
    }
    else if (first === 'UPDATE') operation = 'update';
    else if (first === 'DELETE') operation = 'delete';
    else throw policyError('The statement must start with INSERT, UPDATE or DELETE.');
  }

  let depth = 0;
  let topLevelWhere = false;
  const cteNames = new Set<string>();
  const tables: SqlTableReference[] = [];
  const parameters = new Set<string>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (isSymbol(token, '(')) depth += 1;
    else if (isSymbol(token, ')')) depth -= 1;
    const word = upper(token);

    if (token.type === 'word' && token.value.startsWith('@')) {
      if (token.value.startsWith('@@'))
        throw policyError('System variables (@@...) are not allowed in a Step statement.');
      parameters.add(token.value.slice(1));
    }
    if (!word) continue;
    if (ALWAYS_FORBIDDEN.has(word) || word.startsWith('XP_') || word.startsWith('SP_'))
      throw policyError(`"${word}" is not allowed in a Step statement.`);
    if (word === 'INTO' && !(operation === 'insert' && index === 1))
      throw policyError('"INTO" is only allowed directly after INSERT.');
    if (DML_VERBS.has(word) && index !== 0) {
      // A data-modifying CTE or nested verb; the one place a verb legitimately repeats is none.
      throw policyError(`"${word}" is only allowed at the start of the statement.`);
    }
    if (word === 'WHERE' && depth === 0) topLevelWhere = true;

    // CTE names are not tables: `WITH name AS (` / `, name AS (`.
    if (
      token.type === 'word' &&
      upper(tokens[index + 1]) === 'AS' &&
      isSymbol(tokens[index + 2], '(') &&
      (upper(tokens[index - 1]) === 'WITH' || isSymbol(tokens[index - 1], ','))
    )
      cteNames.add(token.value.toLowerCase());
  }
  if (depth !== 0) throw policyError('The statement has unbalanced parentheses.');
  if ((operation === 'update' || operation === 'delete') && !topLevelWhere)
    throw policyError(
      `${operation === 'update' ? 'UPDATE' : 'DELETE'} needs a WHERE clause so it cannot change every row.`,
    );

  // Table references: names after FROM, JOIN, INTO and UPDATE (and DELETE with no FROM).
  const addTable = (parts: string[]): void => {
    if (parts.length === 0) return;
    if (parts.length > 3)
      throw policyError('Linked-server (four-part) names are not allowed in a Step statement.');
    if (parts.length === 3 && database && parts[0]!.toLowerCase() !== database.toLowerCase())
      throw policyError(`Database "${parts[0]}" is not the database configured for this target.`);
    if (parts.length === 3 && !database)
      throw policyError('Cross-database names are not allowed in a Step statement.');
    const name = parts[parts.length - 1]!;
    if (parts.length === 1 && (name.startsWith('#') || name.startsWith('@'))) return;
    if (parts.length === 1 && cteNames.has(name.toLowerCase())) return;
    tables.push({
      schema: parts.length >= 2 ? parts[parts.length - 2]! : DEFAULT_SCHEMA,
      name,
    });
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const word = upper(tokens[index]);
    const isFrom = word === 'FROM';
    const isTableStart =
      isFrom ||
      word === 'JOIN' ||
      (word === 'INTO' && index === 1) ||
      (word === 'UPDATE' && index === 0) ||
      (word === 'DELETE' && index === 0 && upper(tokens[1]) !== 'FROM');
    if (!isTableStart) continue;
    let cursor = index + 1;
    for (;;) {
      if (isSymbol(tokens[cursor], '(')) break; // subquery or table-valued function: its own FROM is scanned
      const { parts, next } = readName(tokens, cursor);
      if (parts.length === 0) break;
      if (isSymbol(tokens[next], '(')) break; // function call, e.g. a table-valued function
      addTable(parts);
      cursor = next;
      if (upper(tokens[cursor]) === 'AS') cursor += 1;
      const alias = tokens[cursor];
      if (alias && alias.type !== 'symbol' && !NOT_AN_ALIAS.has(upper(alias) ?? '')) cursor += 1;
      if (isFrom && isSymbol(tokens[cursor], ',')) cursor += 1;
      else break;
    }
  }

  return { operation, tables, parameters: [...parameters] };
};
