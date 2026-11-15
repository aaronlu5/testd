import { createServer, type IncomingMessage, type Server } from 'node:http';
import { MOCK_API_LOGGED_HEADERS } from '@test-platform/contracts';
import type { Logger } from '@test-platform/core';
import { MockApiRegistry } from '@test-platform/core';

/** What the server remembers about each request it answered. */
export type MockApiRequestLog = {
  record(entry: {
    method: string;
    path: string;
    query: string;
    requestHeaders: Record<string, string>;
    requestBody?: string;
    requestBodyTruncated?: boolean;
    status: number;
    matched: boolean;
    setupId?: string;
    setupName?: string;
    ruleNumber?: number;
    ruleName?: string;
    responseBody?: string;
  }): unknown;
};

const BODY_CAPTURE_BYTES = 4_096;

export type MockApiServerOptions = {
  registry: MockApiRegistry;
  logger: Logger;
  /** Where answered requests are written for the UI; optional. */
  log?: MockApiRequestLog;
  /** Whether a Run is still worth answering for; a finished Run's setups are dropped. */
  isRunActive: (runId: string) => Promise<boolean>;
  /** Minimum time between checks of the active Runs. */
  pruneEveryMs?: number;
};

/**
 * The Mock API server: answers requests from the SUT with the responses of the setups that the
 * active Runs registered. Only the path and method are looked at (the host is whatever the SUT was
 * pointed at), and the query string is matched only by rules whose pattern has a query part. It reads no request body and holds no secrets.
 */
export const createMockApiServer = (options: MockApiServerOptions): Server => {
  const { registry, logger, isRunActive } = options;
  const pruneEveryMs = options.pruneEveryMs ?? 1_000;
  let lastPrune = 0;

  // A Run paused at a Breakpoint keeps its mocks; a cancelled or finished one must not.
  const prune = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastPrune < pruneEveryMs) return;
    lastPrune = now;
    for (const runId of registry.activeRuns) {
      try {
        if (!(await isRunActive(runId))) registry.unregister(runId);
      } catch {
        /* keep serving; the next request checks again */
      }
    }
  };

  const readBody = (request: IncomingMessage): Promise<{ text?: string; truncated: boolean }> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      request.on('data', (chunk: Buffer) => {
        if (size >= BODY_CAPTURE_BYTES) {
          truncated = true;
          return;
        }
        const room = BODY_CAPTURE_BYTES - size;
        chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        size += Math.min(chunk.length, room);
        if (chunk.length > room) truncated = true;
      });
      const finish = () =>
        resolve({
          ...(size > 0 ? { text: Buffer.concat(chunks).toString('utf8') } : {}),
          truncated,
        });
      request.once('end', finish);
      request.once('error', finish);
    });

  return createServer((request, response) => {
    const send = (status: number, body: string | undefined, extra: Record<string, string> = {}) => {
      response.writeHead(status, {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        'cache-control': 'no-store',
        'x-mock-api': 'true',
        ...extra,
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    void (async () => {
      const body = await readBody(request);
      let parsed: URL;
      try {
        parsed = new URL(request.url ?? '/', 'http://mock.invalid');
      } catch {
        return send(400, JSON.stringify({ error: 'The request path is not valid.' }));
      }
      const path = parsed.pathname;
      const method = request.method ?? 'GET';
      const requestHeaders: Record<string, string> = {};
      for (const name of MOCK_API_LOGGED_HEADERS) {
        const value = request.headers[name];
        if (typeof value === 'string') requestHeaders[name] = value;
      }
      const remember = (entry: {
        status: number;
        matched: boolean;
        responseBody?: string;
        setupId?: string;
        setupName?: string;
        ruleNumber?: number;
        ruleName?: string;
      }) => {
        try {
          options.log?.record({
            method,
            path,
            query: parsed.search,
            requestHeaders,
            ...(body.text !== undefined ? { requestBody: body.text } : {}),
            requestBodyTruncated: body.truncated,
            ...entry,
          });
        } catch (error) {
          logger.warn('Mock API: the request could not be logged', {
            error: error instanceof Error ? error.message : 'unknown',
          });
        }
      };
      await prune();
      const found = registry.match(method, path, parsed.search);
      if (!found) {
        logger.info('Mock API: no setup matched', { method, path });
        const payload = JSON.stringify({
          error: 'No Mock API rule matches this request.',
          method,
          path,
          activeRuns: registry.activeRuns.length,
        });
        remember({ status: 404, matched: false, responseBody: payload });
        return send(404, payload, { 'x-mock-api-match': 'none' });
      }
      logger.info('Mock API: answered', {
        method,
        path,
        status: found.status,
        setup: found.setupName,
        rule: found.ruleName ?? found.ruleIndex + 1,
      });
      remember({
        status: found.status,
        matched: true,
        ...(found.body !== undefined ? { responseBody: found.body } : {}),
        setupId: found.setupId,
        setupName: found.setupName,
        ruleNumber: found.ruleIndex + 1,
        ...(found.ruleName ? { ruleName: found.ruleName } : {}),
      });
      send(found.status, found.body, {
        'x-mock-api-match': `${found.setupId}#${found.ruleIndex + 1}`,
      });
    })().catch(() => send(500, JSON.stringify({ error: 'The Mock API server failed.' })));
  });
};
