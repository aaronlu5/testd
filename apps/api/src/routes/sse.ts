import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Container } from '../container.js';

export const EVENT_BATCH = 200;

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

export type EventStreamSource<E extends { seq?: number; type: string }> = {
  /** Current status of the resource, or undefined when it no longer exists. */
  status(): Promise<string | undefined>;
  events(afterSeq: number, limit: number): Promise<E[]>;
  isTerminal(status: string): boolean;
};

/**
 * Server-Sent Events backed by the persisted event feed, so events written by the worker process
 * are delivered. Clients resume with `Last-Event-ID`. The stream ends once the resource is
 * terminal and its events are drained; events must be published before the terminal transition
 * for that to be loss-free.
 *
 * Recovery contract for reconnecting clients: event history is a convenience, never the source
 * of truth. A client that has lost its place fetches the full resource (which reports
 * `lastEventSeq`), renders it, then opens the stream with that value as `Last-Event-ID`.
 */
export const serveEventStream = async <E extends { seq?: number; type: string }>(
  request: FastifyRequest,
  reply: FastifyReply,
  options: {
    container: Container;
    shutdown: AbortSignal;
    source: EventStreamSource<E>;
    lastSeq: number;
    mask: <T>(value: T) => T;
  },
): Promise<void> => {
  const { container, source, mask } = options;
  let lastSeq = options.lastSeq;

  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    ...(reply.getHeaders() as Record<string, string | string[]>),
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  });
  raw.write('retry: 2000\n\n');

  const closed = new AbortController();
  const stop = (): void => closed.abort();
  request.raw.on('close', stop);
  options.shutdown.addEventListener('abort', stop, { once: true });

  let lastWrite = Date.now();
  const write = (chunk: string): void => {
    if (!raw.writableEnded && !raw.destroyed) raw.write(chunk);
    lastWrite = Date.now();
  };

  try {
    while (!closed.signal.aborted) {
      // Status is read before the events so a terminal status implies no later events.
      const status = await source.status();
      const events = await source.events(lastSeq, EVENT_BATCH);
      for (const event of events) {
        write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(mask(event))}\n\n`);
        lastSeq = event.seq ?? lastSeq;
      }
      if (events.length === EVENT_BATCH) continue;
      if (events.length === 0 && (status === undefined || source.isTerminal(status))) {
        write('event: end\ndata: {}\n\n');
        break;
      }
      if (Date.now() - lastWrite >= container.config.sseHeartbeatMs) write(': keepalive\n\n');
      await sleep(container.config.ssePollMs, closed.signal);
    }
  } catch (error) {
    // The response is already hijacked, so the error handler cannot reply; log and close.
    request.log.error(
      { err: { message: container.redactor.redactText((error as Error).message) } },
      'SSE stream failed',
    );
  } finally {
    request.raw.off('close', stop);
    if (!raw.writableEnded) raw.end();
  }
};
