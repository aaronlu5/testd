import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunSummary } from '@test-platform/contracts';
import { cleanupAll, createTestApp, seedRunInputs, SECRET, type TestApp } from './helpers.js';

afterEach(cleanupAll);

type SseMessage = { id?: string; event?: string; data?: string };

const listen = async (t: TestApp): Promise<string> => {
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  return `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
};

const parseMessages = (text: string): SseMessage[] =>
  text
    .split('\n\n')
    .filter((block) => block.trim() !== '' && !block.startsWith(':') && !block.startsWith('retry:'))
    .map(
      (block) =>
        Object.fromEntries(
          block
            .split('\n')
            .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]),
        ) as SseMessage,
    );

/** Reads from an SSE response until `done` returns true or the stream ends. */
const readStream = async (
  response: Response,
  done: (messages: SseMessage[], raw: string) => boolean = () => false,
): Promise<{ messages: SseMessage[]; ended: boolean; raw: string }> => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  for (;;) {
    const { value, done: finished } = await reader.read();
    if (finished) return { messages: parseMessages(raw), ended: true, raw };
    raw += decoder.decode(value, { stream: true });
    if (done(parseMessages(raw), raw)) {
      await reader.cancel();
      return { messages: parseMessages(raw), ended: false, raw };
    }
  }
};

const createRun = async (t: TestApp): Promise<RunSummary> => {
  const response = await t.request({
    method: 'POST',
    url: '/api/v1/runs',
    payload: await seedRunInputs(t),
  });
  return t.json<RunSummary>(response);
};

const publish = (t: TestApp, runId: string, status: 'Running' | 'Succeeded') =>
  t.container.infra.events.publish({
    type: 'run.status',
    runId,
    timestamp: new Date().toISOString(),
    data: { status },
  });

describe('GET /runs/{id}/events (SSE)', () => {
  it('replays persisted events, streams new ones written by another process, and ends when the Run finishes', async () => {
    const t = await createTestApp();
    const base = await listen(t);
    const run = await createRun(t);

    const response = await fetch(`${base}/api/v1/runs/${run.id}/events`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toContain('no-cache');
    expect(response.headers.get('x-request-id')).toBeTruthy();

    // The "worker": publishes events, then performs the terminal transition.
    setTimeout(async () => {
      await t.container.infra.runs.transitionRun(run.id, {
        from: 'Queued',
        to: 'Running',
        at: new Date().toISOString(),
      });
      await publish(t, run.id, 'Running');
      await publish(t, run.id, 'Succeeded');
      await t.container.infra.runs.transitionRun(run.id, {
        from: 'Running',
        to: 'Succeeded',
        at: new Date().toISOString(),
      });
    }, 60);

    const { messages, ended } = await readStream(response);
    expect(ended).toBe(true);
    const statuses = messages
      .filter((m) => m.event === 'run.status')
      .map((m) => (JSON.parse(m.data as string) as { data: { status: string } }).data.status);
    expect(statuses).toEqual(['Queued', 'Running', 'Succeeded']);
    expect(messages.at(-1)).toMatchObject({ event: 'end' });
    expect(messages.filter((m) => m.event === 'run.status').map((m) => Number(m.id))).toEqual([
      1, 2, 3,
    ]);
  });

  it('resumes after Last-Event-ID without repeating events', async () => {
    const t = await createTestApp();
    const base = await listen(t);
    const run = await createRun(t);
    await publish(t, run.id, 'Running');
    await publish(t, run.id, 'Succeeded');
    await t.container.infra.runs.transitionRun(run.id, { from: 'Queued', to: 'Running', at: 'x' });
    await t.container.infra.runs.transitionRun(run.id, {
      from: 'Running',
      to: 'Succeeded',
      at: 'x',
    });

    const viaHeader = await readStream(
      await fetch(`${base}/api/v1/runs/${run.id}/events`, { headers: { 'Last-Event-ID': '2' } }),
    );
    expect(viaHeader.messages.filter((m) => m.event === 'run.status').map((m) => m.id)).toEqual([
      '3',
    ]);

    const viaQuery = await readStream(
      await fetch(`${base}/api/v1/runs/${run.id}/events?lastEventId=1`),
    );
    expect(viaQuery.messages.filter((m) => m.event === 'run.status').map((m) => m.id)).toEqual([
      '2',
      '3',
    ]);
  });

  it('sends keep-alive comments while a Run is idle and tolerates the client disconnecting', async () => {
    const t = await createTestApp();
    const base = await listen(t);
    const run = await createRun(t);

    const response = await fetch(`${base}/api/v1/runs/${run.id}/events`);
    const { raw, ended } = await readStream(response, (_messages, text) =>
      text.includes(': keepalive'),
    );
    expect(ended).toBe(false);
    expect(raw).toContain(': keepalive');
    // The client cancelled; later requests are unaffected.
    expect((await t.request({ url: `/api/v1/runs/${run.id}` })).statusCode).toBe(200);
  });

  it('returns problem responses (not a stream) for unknown Runs and bad Last-Event-ID', async () => {
    const t = await createTestApp();
    const base = await listen(t);
    const unknown = await fetch(`${base}/api/v1/runs/nope/events`);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('content-type')).toContain('application/problem+json');

    const run = await createRun(t);
    const bad = await fetch(`${base}/api/v1/runs/${run.id}/events`, {
      headers: { 'Last-Event-ID': 'abc' },
    });
    expect(bad.status).toBe(422);
  });

  it('masks registered secrets in streamed events', async () => {
    const t = await createTestApp();
    const base = await listen(t);
    const run = await createRun(t);
    await t.container.infra.events.publish({
      type: 'step.log',
      runId: run.id,
      timestamp: new Date().toISOString(),
      data: {
        stepRunId: 's1',
        entry: { timestamp: new Date().toISOString(), level: 'info', message: `token ${SECRET}` },
      },
    });
    await t.container.infra.runs.transitionRun(run.id, {
      from: 'Queued',
      to: 'Cancelled',
      at: 'x',
    });

    const { raw } = await readStream(await fetch(`${base}/api/v1/runs/${run.id}/events`));
    expect(raw).toContain('step.log');
    expect(raw).not.toContain(SECRET);
  });

  it('is closed cleanly on server shutdown while a client is connected', async () => {
    const t = await createTestApp();
    const base = await listen(t);
    const run = await createRun(t);
    const response = await fetch(`${base}/api/v1/runs/${run.id}/events`);
    const reading = readStream(response);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await t.app.close();
    expect((await reading).ended).toBe(true);
  });
});
