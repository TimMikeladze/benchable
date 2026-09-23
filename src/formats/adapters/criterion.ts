import { FormatParseError, type FormatAdapter, type MetricValue } from "../types";
import {compactMetric, isRecord, metricKey, precise, round, toMilliseconds, toNumber } from "../util";

/**
 * Criterion.rs machine-readable output — NDJSON, one object per line. Only
 * `benchmark-complete` messages carry measurements; the rest are progress chatter.
 */
function completeMessages(raw: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed) && parsed.reason === "benchmark-complete") out.push(parsed);
    } catch {
      // A truncated or interleaved line is not fatal — skip it and keep the rest.
    }
  }
  return out;
}

function estimateMs(value: unknown, fallbackUnit: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const estimate = toNumber(value.estimate);
  if (estimate === undefined) return undefined;
  const unit = typeof value.unit === "string" ? value.unit : fallbackUnit;
  return toMilliseconds(estimate, unit);
}

export const criterion: FormatAdapter = {
  id: "criterion",
  label: "Criterion.rs",
  description: "Rust microbenchmarks from Criterion's NDJSON output, using typical and median.",
  produce: "cargo criterion --message-format=json > bench.ndjson",

  detect(input) {
    if (!input.raw.includes("benchmark-complete")) return false;
    return completeMessages(input.raw).length > 0;
  },

  parse(input) {
    const messages = completeMessages(input.raw);
    if (messages.length === 0) {
      throw new FormatParseError("No `benchmark-complete` messages found", "criterion");
    }

    const metrics: Record<string, MetricValue> = {};
    for (const message of messages) {
      const id = typeof message.id === "string" ? message.id : "benchmark";
      const unit = typeof message.unit === "string" ? message.unit : "ns";

      const typical = estimateMs(message.typical, unit);
      const mean = estimateMs(message.mean, unit);
      const median = estimateMs(message.median, unit);
      const mad = estimateMs(message.median_abs_dev, unit);
      const value = typical ?? mean ?? median;
      if (value === undefined) continue;

      const measured = Array.isArray(message.measured_values)
        ? message.measured_values.filter((v): v is number => typeof v === "number")
        : [];

      metrics[metricKey("criterion", id, "ms")] = compactMetric({
        value: precise(value),
        unit: "ms",
        direction: "lower",
        name: id,
        mean: mean === undefined ? undefined : precise(mean),
        p50: median === undefined ? undefined : precise(median),
        stddev: mad === undefined ? undefined : precise(mad),
        samples: measured.length || undefined,
      });

      if (Array.isArray(message.throughput)) {
        for (const throughput of message.throughput) {
          if (!isRecord(throughput)) continue;
          const perSecond = toNumber(throughput.per_iteration);
          const throughputUnit =
            typeof throughput.unit === "string" ? throughput.unit : "items";
          if (perSecond === undefined || value === 0) continue;
          metrics[metricKey("criterion", id, `${throughputUnit}_per_second`)] = compactMetric({
            value: precise((perSecond / value) * 1000),
            unit: `${throughputUnit}/s`,
            direction: "higher",
          });
        }
      }
    }

    return { format: "criterion", metrics };
  },
};
