import { FormatParseError, type FormatAdapter, type MetricValue } from "../types";
import {compactMetric, isRecord, metricKey, precise, round, toNumber } from "../util";

/** `pytest --benchmark-json=out.json`. Stats are in seconds; stored as milliseconds. */
export const pytestBenchmark: FormatAdapter = {
  id: "pytest-benchmark",
  label: "pytest-benchmark",
  description: "Python benchmark stats from pytest-benchmark, with median, IQR and ops/s.",
  produce: "pytest --benchmark-json=bench.json",

  detect(input) {
    if (!isRecord(input.json)) return false;
    const benchmarks = input.json.benchmarks;
    if (!Array.isArray(benchmarks) || benchmarks.length === 0) return false;
    const first = benchmarks[0];
    return isRecord(first) && isRecord(first.stats) && "name" in first;
  },

  parse(input) {
    if (!isRecord(input.json) || !Array.isArray(input.json.benchmarks)) {
      throw new FormatParseError("Expected a `benchmarks` array", "pytest-benchmark");
    }

    const metrics: Record<string, MetricValue> = {};
    const metadata: Record<string, unknown> = {};

    if (isRecord(input.json.machine_info)) {
      metadata.machine = input.json.machine_info;
    }
    if (isRecord(input.json.commit_info) && typeof input.json.commit_info.id === "string") {
      metadata.commit = input.json.commit_info.id;
    }

    for (const entry of input.json.benchmarks) {
      if (!isRecord(entry) || !isRecord(entry.stats)) continue;
      const name = typeof entry.name === "string" ? entry.name : "benchmark";
      const stats = entry.stats;
      const mean = toNumber(stats.mean);
      if (mean === undefined) continue;

      const ms = (value: unknown) => {
        const n = toNumber(value);
        return n === undefined ? undefined : precise(n * 1000);
      };

      metrics[metricKey("pytest", name, "mean_ms")] = compactMetric({
        value: precise(mean * 1000),
        unit: "ms",
        direction: "lower",
        name,
        min: ms(stats.min),
        max: ms(stats.max),
        mean: precise(mean * 1000),
        p50: ms(stats.median),
        stddev: ms(stats.stddev),
        samples: toNumber(stats.rounds),
        labels: typeof entry.group === "string" ? { group: entry.group } : undefined,
      });

      const ops = toNumber(stats.ops);
      if (ops !== undefined) {
        metrics[metricKey("pytest", name, "ops")] = compactMetric({
          value: precise(ops),
          unit: "ops/s",
          direction: "higher",
        });
      }
    }

    return { format: "pytest-benchmark", metrics, metadata };
  },
};
