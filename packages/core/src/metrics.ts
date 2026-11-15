/**
 * Metrics port. Labels must be low-cardinality enumerations (Step type, status, error code);
 * never a Run id, payload, URL, secret name or any other free text. The default sink discards
 * everything, so instrumented code needs no guards.
 */
export type MetricLabels = Readonly<Record<string, string>>;

export interface MetricsSink {
  /** Adds `value` (default 1) to a monotonically increasing counter. */
  increment(name: string, labels?: MetricLabels, value?: number): void;
  /** Records one observation (for example a duration in milliseconds). */
  observe(name: string, value: number, labels?: MetricLabels): void;
}

export const noopMetrics: MetricsSink = { increment: () => undefined, observe: () => undefined };

const LABEL_VALUE_MAX = 64;
const SAFE_LABEL = /[^A-Za-z0-9_.:-]/g;

/** Bounds label values so a stray identifier or message cannot create unbounded series. */
export const safeLabels = (labels: MetricLabels = {}): MetricLabels =>
  Object.fromEntries(
    Object.entries(labels).map(([key, value]) => [
      key,
      value.replace(SAFE_LABEL, '_').slice(0, LABEL_VALUE_MAX),
    ]),
  );

type Series = { name: string; labels: MetricLabels };
type Counter = Series & { value: number };
type Summary = Series & { count: number; sum: number; max: number };

const keyOf = (name: string, labels: MetricLabels): string =>
  `${name}|${Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(',')}`;

const escapeLabel = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');

const formatLabels = (labels: MetricLabels, extra: MetricLabels = {}): string => {
  const entries = Object.entries({ ...labels, ...extra }).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0
    ? ''
    : `{${entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',')}}`;
};

export interface MetricsRegistry extends MetricsSink {
  /** Prometheus text exposition; `gauges` are point-in-time values supplied by the caller. */
  render(gauges?: readonly { name: string; value: number; labels?: MetricLabels }[]): string;
  snapshot(): { counters: Counter[]; summaries: Summary[] };
}

/** In-process registry. Observations are exposed as `_count`, `_sum` and `_max`. */
export const createMetricsRegistry = (): MetricsRegistry => {
  const counters = new Map<string, Counter>();
  const summaries = new Map<string, Summary>();

  return {
    increment(name, labels, value = 1) {
      const safe = safeLabels(labels);
      const key = keyOf(name, safe);
      const existing = counters.get(key);
      if (existing) existing.value += value;
      else counters.set(key, { name, labels: safe, value });
    },
    observe(name, value, labels) {
      if (!Number.isFinite(value)) return;
      const safe = safeLabels(labels);
      const key = keyOf(name, safe);
      const existing = summaries.get(key);
      if (existing) {
        existing.count += 1;
        existing.sum += value;
        existing.max = Math.max(existing.max, value);
      } else summaries.set(key, { name, labels: safe, count: 1, sum: value, max: value });
    },
    snapshot: () => ({ counters: [...counters.values()], summaries: [...summaries.values()] }),
    render(gauges = []) {
      const lines: string[] = [];
      const typed = new Set<string>();
      const header = (name: string, type: string): void => {
        if (typed.has(name)) return;
        typed.add(name);
        lines.push(`# TYPE ${name} ${type}`);
      };
      for (const item of [...counters.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        header(item.name, 'counter');
        lines.push(`${item.name}${formatLabels(item.labels)} ${item.value}`);
      }
      for (const item of [...summaries.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        header(`${item.name}_count`, 'counter');
        lines.push(`${item.name}_count${formatLabels(item.labels)} ${item.count}`);
        header(`${item.name}_sum`, 'counter');
        lines.push(`${item.name}_sum${formatLabels(item.labels)} ${item.sum}`);
        header(`${item.name}_max`, 'gauge');
        lines.push(`${item.name}_max${formatLabels(item.labels)} ${item.max}`);
      }
      for (const gauge of gauges) {
        header(gauge.name, 'gauge');
        lines.push(`${gauge.name}${formatLabels(safeLabels(gauge.labels))} ${gauge.value}`);
      }
      return `${lines.join('\n')}\n`;
    },
  };
};

/** Metric names used by the platform. */
export const METRICS = {
  jobsClaimed: 'platform_jobs_claimed_total',
  jobsRecovered: 'platform_jobs_recovered_total',
  runsStarted: 'platform_runs_started_total',
  runsFinished: 'platform_runs_finished_total',
  runsPaused: 'platform_runs_paused_total',
  runsResumed: 'platform_runs_resumed_total',
  stepAttempts: 'platform_step_attempts_total',
  stepFailures: 'platform_step_failures_total',
  stepDurationMs: 'platform_step_duration_ms',
  stepRetries: 'platform_step_retries_total',
  suiteDispatched: 'platform_suite_children_dispatched_total',
  suiteAdvanced: 'platform_suite_runs_advanced_total',
  inspectorMessages: 'platform_inspector_messages_total',
  inspectorPollFailures: 'platform_inspector_poll_failures_total',
} as const;

/** The subset of an OpenTelemetry `Meter` used by the bridge (structural; no dependency). */
export interface OtelMeterLike {
  createCounter(name: string): { add(value: number, attributes?: Record<string, string>): void };
  createHistogram(name: string): {
    record(value: number, attributes?: Record<string, string>): void;
  };
}

/** Bridges the metrics port to an OpenTelemetry meter supplied by the host process. */
export const createOtelMetricsSink = (meter: OtelMeterLike): MetricsSink => {
  const counters = new Map<string, ReturnType<OtelMeterLike['createCounter']>>();
  const histograms = new Map<string, ReturnType<OtelMeterLike['createHistogram']>>();
  return {
    increment(name, labels, value = 1) {
      let counter = counters.get(name);
      if (!counter) counters.set(name, (counter = meter.createCounter(name)));
      counter.add(value, { ...safeLabels(labels) });
    },
    observe(name, value, labels) {
      let histogram = histograms.get(name);
      if (!histogram) histograms.set(name, (histogram = meter.createHistogram(name)));
      histogram.record(value, { ...safeLabels(labels) });
    },
  };
};
