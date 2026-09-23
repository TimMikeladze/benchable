import type { MetricValue } from "./types";

/**
 * Metric keys are addressable in URLs and readable in tables, so arbitrary benchmark names
 * are folded to `[A-Za-z0-9._/-]`. Case is preserved: `BenchmarkEncode` is how Go users
 * know that benchmark, and lowercasing it would make it harder to find, not easier.
 */
export function safeKeySegment(value: string): string {
  return (
    value
      .trim()
      .replace(/\s+/g, "_")
      .replace(/[^A-Za-z0-9._/-]/g, "_")
      .replace(/_{2,}/g, "_")
      .replace(/^[._\-/]+|[._\-/]+$/g, "")
      .slice(0, 120) || "unnamed"
  );
}

export function metricKey(...segments: string[]): string {
  return segments
    .filter((segment) => segment !== undefined && segment !== null && segment !== "")
    .map(safeKeySegment)
    .join(".")
    .slice(0, 200);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Coerce a JSON value that should be numeric, tolerating the numeric strings some tools emit. */
export function toNumber(value: unknown): number | undefined {
  if (isFiniteNumber(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Drop undefined stats so the ingest payload stays small and the columns stay null. */
export function compactMetric(metric: MetricValue): MetricValue {
  const out: MetricValue = { value: metric.value };
  for (const [key, value] of Object.entries(metric)) {
    if (key === "value") continue;
    if (value === undefined || value === null) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    (out as unknown as Record<string, unknown>)[key] = value;
  }
  return out;
}

const SECOND_UNITS: Record<string, number> = {
  ns: 1e-6,
  nanosecond: 1e-6,
  nanoseconds: 1e-6,
  us: 1e-3,
  "µs": 1e-3,
  microsecond: 1e-3,
  microseconds: 1e-3,
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1000,
  sec: 1000,
  second: 1000,
  seconds: 1000,
  m: 60_000,
  min: 60_000,
  minute: 60_000,
  minutes: 60_000,
};

/** Convert a duration in `unit` to milliseconds, or undefined when the unit is unknown. */
export function toMilliseconds(value: number, unit: string): number | undefined {
  const multiplier = SECOND_UNITS[unit.trim().toLowerCase()];
  return multiplier === undefined ? undefined : value * multiplier;
}

/** Round to a fixed number of decimal places. For deliberate display rounding only. */
export function round(value: number, digits = 4): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Normalize a measured value.
 *
 * Benchmark values span from 1e-6 (a nanosecond expressed in ms) to 1e9 (bytes per second),
 * so rounding to a fixed number of decimals would erase the small ones. Twelve significant
 * digits keeps every real measurement intact while removing float artifacts such as
 * `0.30000000000000004` from unit conversion.
 */
export function precise(value: number): number {
  if (!Number.isFinite(value) || value === 0) return value;
  return Number(value.toPrecision(12));
}
