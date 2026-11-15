/** Request headers worth showing when a request to the Mock API server is inspected. */
export const MOCK_API_LOGGED_HEADERS = [
  'host',
  'content-type',
  'content-length',
  'accept',
  'user-agent',
  'x-correlation-id',
] as const;

/** How long the status counts as live after the worker's last heartbeat. */
export const MOCK_API_HEARTBEAT_TTL_MS = 20_000;

/** One request the Mock API server received and the response it returned. */
export type MockApiRequestRecord = {
  /** Increases with every request; use it to ask for what is new. */
  id: number;
  at: string;
  method: string;
  path: string;
  /** The query string including the leading "?", or empty. */
  query: string;
  requestHeaders: Record<string, string>;
  /** Up to the first few KB of the request body, as text. */
  requestBody?: string;
  requestBodyTruncated: boolean;
  /** The status returned (404 when no rule matched). */
  status: number;
  matched: boolean;
  setupId?: string;
  setupName?: string;
  /** 1-based position of the rule within its setup. */
  ruleNumber?: number;
  ruleName?: string;
  responseBody?: string;
};

export type MockApiRequestPage = {
  /** Newest first. */
  items: MockApiRequestRecord[];
  total: number;
  /** The highest id stored; 0 when there are none. */
  lastId: number;
  /** The log keeps only this many; older requests are dropped. */
  maxRecords: number;
};

/** What the worker reports about the Mock API server. */
export type MockApiStatus = {
  /** True when the worker reported the server listening recently. */
  running: boolean;
  /** The address the system under test should call. */
  baseUrl: string;
  host?: string;
  port?: number;
  startedAt?: string;
  lastSeenAt?: string;
  /** Runs whose setups are answering requests right now. */
  activeRuns: number;
  /** Id of the newest logged request (0 when none), so clients can tell when something is new. */
  lastRequestId: number;
  /** Why the server is not running, when it is not. */
  message?: string;
};

const BACKSLASH = String.fromCharCode(92);

/** A rule's path pattern, split into the part for the path and the optional part for the query. */
export type MockPathPattern = { path: string; query?: string };

/**
 * A rule may match the query string too: the pattern is split at the first unescaped "?" that is
 * followed by a "key=value" (so `/items?` and `/a/b?` stay regular-expression quantifiers). In
 * either part, a "$" directly before a letter or digit is taken literally, because an end anchor
 * could never be followed by one; this lets `$filter` be written as is.
 */
export const splitMockPattern = (pattern: string): MockPathPattern => {
  let backslashes = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === BACKSLASH) {
      backslashes += 1;
      continue;
    }
    const escaped = backslashes % 2 === 1;
    backslashes = 0;
    if (char === '?' && !escaped && index > 0 && pattern.slice(index + 1).includes('=')) {
      return { path: pattern.slice(0, index), query: pattern.slice(index + 1) };
    }
  }
  return { path: pattern };
};

const literalDollars = (source: string): string => {
  let result = '';
  let backslashes = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] as string;
    if (char === '$' && backslashes % 2 === 0 && /\w/.test(source[index + 1] ?? '')) {
      result += `${BACKSLASH}$`;
    } else {
      result += char;
    }
    backslashes = char === BACKSLASH ? backslashes + 1 : 0;
  }
  return result;
};

export type CompiledMockPattern = { path: RegExp; query?: RegExp };

/** Throws a SyntaxError when either part is not a valid regular expression. */
export const compileMockPattern = (pattern: string): CompiledMockPattern => {
  const parts = splitMockPattern(pattern);
  return {
    path: new RegExp(`^(?:${literalDollars(parts.path)})$`),
    ...(parts.query === undefined
      ? {}
      : { query: new RegExp(`^(?:${literalDollars(parts.query)})$`) }),
  };
};

const decoded = (text: string): string => {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
};

/** The query part is tried against the query as sent and as decoded ("%20" as a space). */
export const matchesMockPattern = (
  compiled: CompiledMockPattern,
  path: string,
  query = '',
): boolean => {
  if (!compiled.path.test(path)) return false;
  if (!compiled.query) return true;
  const raw = query.startsWith('?') ? query.slice(1) : query;
  return compiled.query.test(raw) || compiled.query.test(decoded(raw));
};
