import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createMetricsRegistry, createOtelMetricsSink, safeLabels } from '@test-platform/core';
import { createHealthServer } from '../src/health.js';
import { SECRET, cleanupAll, createHarness, makeRun, node, submit } from './helpers.js';

afterEach(cleanupAll);

describe('metrics registry', () => {
  it('renders counters, summaries and gauges as Prometheus text', () => {
    const metrics = createMetricsRegistry();
    metrics.increment('a_total', { status: 'ok' });
    metrics.increment('a_total', { status: 'ok' }, 2);
    metrics.observe('d_ms', 10, { type: 'delay' });
    metrics.observe('d_ms', 30, { type: 'delay' });
    const text = metrics.render([{ name: 'g', value: 4 }]);
    expect(text).toContain('a_total{status="ok"} 3');
    expect(text).toContain('d_ms_count{type="delay"} 2');
    expect(text).toContain('d_ms_sum{type="delay"} 40');
    expect(text).toContain('d_ms_max{type="delay"} 30');
    expect(text).toContain('g 4');
  });

  it('bounds label values so free text cannot become a series', () => {
    const labels = safeLabels({ code: `Key=${'x'.repeat(200)} and spaces\n` });
    expect(labels.code?.length).toBeLessThanOrEqual(64);
    expect(labels.code).not.toMatch(/[\s=]/);
  });

  it('bridges to an OpenTelemetry-style meter', () => {
    const seen: string[] = [];
    const sink = createOtelMetricsSink({
      createCounter: (name) => ({
        add: (value, attrs) => seen.push(`${name}+${value}${JSON.stringify(attrs)}`),
      }),
      createHistogram: (name) => ({ record: (value) => seen.push(`${name}=${value}`) }),
    });
    sink.increment('c', { k: 'v' });
    sink.observe('h', 5);
    expect(seen).toEqual(['c+1{"k":"v"}', 'h=5']);
  });
});

describe('worker metrics', () => {
  it('counts Runs, Steps, pauses and resumes without capturing payloads or secrets', async () => {
    const h = await createHarness();
    const run = makeRun([
      node('shape', 'transform.json', { input: { token: SECRET }, mapping: { t: '$.token' } }),
      node('inspect', 'breakpoint', { enabled: true }),
      node('verify', 'assert', { actual: 1, operator: 'equals', expected: 1 }),
    ]);
    await submit(h.container, run);
    await h.container.loop.runOnce();
    await h.container.infra.pauses.resumeRun({
      runId: run.id,
      at: '2026-01-01T00:10:00.000Z',
      expectedGeneration: 0,
    });
    await h.container.loop.runOnce();

    const server = createHealthServer(h.container);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/metrics`);
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).toContain('platform_runs_started_total{continuation="false"} 1');
      expect(text).toContain('platform_runs_started_total{continuation="true"} 1');
      expect(text).toContain('platform_runs_paused_total 1');
      expect(text).toContain('platform_runs_resumed_total 1');
      expect(text).toContain('platform_runs_finished_total{status="Succeeded"} 1');
      expect(text).toContain(
        'platform_step_attempts_total{outcome="succeeded",type="transform.json"} 1',
      );
      expect(text).toContain('platform_jobs_queued 0');
      expect(text).toContain('platform_runs_paused 0');
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(run.id);
    } finally {
      server.close();
    }
  });
});
