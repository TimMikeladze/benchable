import { z } from "zod";

import { mean as meanOf, quantile, stddev as stddevOf } from "./statistics";

/**
 * The ingest payload defines the metric schema — nothing is predeclared. A metric may be
 * reported as a bare number or as an object carrying whatever statistics the producer has.
 */

const finite = z.number().finite();

/** Enough to describe any distribution; small enough that a row stays a row. */
export const MAX_SAMPLE_VALUES = 2000;

/**
 * How many samples a producer may send. Well above what we store, because a tool that ran
 * 10,000 iterations should not get a validation error for being thorough — we downsample it.
 * The body size limit is the real backstop.
 */
export const MAX_PAYLOAD_VALUES = 50_000;

export const metricDirectionSchema = z.enum(["lower", "higher"]);

export const metricPayloadSchema = z.union([
  finite,
  z.object({
    value: finite,
    unit: z.string().max(32).optional(),
    direction: metricDirectionSchema.optional(),
    name: z.string().max(120).optional(),
    description: z.string().max(500).optional(),
    samples: z.number().int().positive().optional(),
    min: finite.optional(),
    max: finite.optional(),
    mean: finite.optional(),
    p50: finite.optional(),
    p95: finite.optional(),
    p99: finite.optional(),
    stddev: finite.nonnegative().optional(),
    /**
     * The raw samples. Worth sending: with vectors on both sides a comparison uses
     * Mann–Whitney U, which assumes no distribution at all — the right test for timings.
     */
    values: z.array(finite).max(MAX_PAYLOAD_VALUES).optional(),
    labels: z.record(z.string(), z.string()).optional(),
  }),
]);

export const spanPayloadSchema = z.object({
  id: z.string().min(1).max(120),
  /** Groups spans into traces inside one run. Absent means the run is a single trace. */
  traceId: z.string().min(1).max(120).optional(),
  /** Emitting service, when the format knows it (`service.name`, process, endpoint). */
  service: z.string().min(1).max(200).optional(),
  parentId: z.string().min(1).max(120).nullish(),
  name: z.string().min(1).max(200),
  startMs: finite.nonnegative(),
  durationMs: finite.nonnegative(),
  status: z.enum(["ok", "error"]).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

export const runPayloadSchema = z.object({
  label: z.string().max(200).optional(),
  commitSha: z.string().max(80).optional(),
  branch: z.string().max(200).optional(),
  environment: z.string().max(120).optional(),
  source: z.string().max(80).optional(),
  startedAt: z.coerce.date().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  metrics: z.record(z.string().min(1).max(200), metricPayloadSchema),
  /** Makes a re-send return the original run. Also read from the header or query string. */
  idempotencyKey: z.string().max(200).optional(),
  spans: z.array(spanPayloadSchema).max(5000).optional(),
});

export type RunPayload = z.infer<typeof runPayloadSchema>;
export type MetricPayload = z.infer<typeof metricPayloadSchema>;
export type SpanPayload = z.infer<typeof spanPayloadSchema>;

export interface NormalizedMetric {
  key: string;
  value: number;
  unit?: string;
  direction?: "lower" | "higher";
  name?: string;
  description?: string;
  samples?: number;
  min?: number;
  max?: number;
  mean?: number;
  p50?: number;
  p95?: number;
  p99?: number;
  stddev?: number;
  values?: number[];
  labels?: Record<string, string>;
}

/** Unit suffixes we can read off a metric key when the payload doesn't say. */
const UNIT_SUFFIXES: Record<string, string> = {
  ms: "ms",
  s: "s",
  ns: "ns",
  us: "µs",
  bytes: "bytes",
  kb: "KB",
  mb: "MB",
  gb: "GB",
  pct: "%",
  percent: "%",
  ratio: "ratio",
  count: "count",
  ops: "ops/s",
  rps: "req/s",
  qps: "q/s",
  usd: "USD",
  tokens: "tokens",
};

/** Keys whose value is better when it goes up. Everything else defaults to lower-is-better. */
const HIGHER_IS_BETTER = /(throughput|ops|rps|qps|score|coverage|accuracy|hit_?rate|uptime|success)/i;

export function inferUnit(key: string): string | undefined {
  const suffix = key.split(/[._\-/]/).pop()?.toLowerCase();
  return suffix ? UNIT_SUFFIXES[suffix] : undefined;
}

export function inferDirection(key: string): "lower" | "higher" {
  return HIGHER_IS_BETTER.test(key) ? "higher" : "lower";
}

/** Turn `key.split(".")` into something readable: `api.p95_latency_ms` -> `Api P95 Latency`. */
export function humanizeMetricKey(key: string): string {
  const unitSuffix = inferUnit(key);
  const parts = key.split(/[._\-/]/).filter(Boolean);
  if (unitSuffix && parts.length > 1) {
    const last = parts[parts.length - 1].toLowerCase();
    if (UNIT_SUFFIXES[last]) parts.pop();
  }
  return parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function normalizeMetrics(metrics: RunPayload["metrics"]): NormalizedMetric[] {
  return Object.entries(metrics).map(([key, payload]) => {
    if (typeof payload === "number") return { key, value: payload };
    return withDerivedStats({ key, ...payload });
  });
}

/**
 * Evenly spaced downsample. Keeps the shape of the distribution — the tail included, which a
 * `slice(0, n)` would throw away exactly when the producer sorted its samples.
 */
export function downsample(values: readonly number[], limit = MAX_SAMPLE_VALUES): number[] {
  if (values.length <= limit) return [...values];
  const step = values.length / limit;
  return Array.from({ length: limit }, (_, i) => values[Math.floor(i * step)]);
}

/**
 * Fill in whatever the producer did not compute. A tool that sends the samples should not
 * also have to send the percentiles, and percentiles we derive ourselves are consistent
 * across every producer rather than being each tool's idea of what p95 means.
 */
export function withDerivedStats(entry: NormalizedMetric): NormalizedMetric {
  const values = entry.values;
  if (!values || values.length === 0) return entry;

  const sampled = downsample(values);
  return {
    ...entry,
    values: sampled,
    samples: entry.samples ?? values.length,
    min: entry.min ?? Math.min(...values),
    max: entry.max ?? Math.max(...values),
    mean: entry.mean ?? meanOf(values),
    p50: entry.p50 ?? quantile(values, 0.5),
    p95: entry.p95 ?? quantile(values, 0.95),
    p99: entry.p99 ?? quantile(values, 0.99),
    stddev: entry.stddev ?? (values.length > 1 ? stddevOf(values) : undefined),
  };
}
