import { FormatParseError, type FormatAdapter, type MetricValue } from "../types";
import {compactMetric, isRecord, metricKey, precise, round, toMilliseconds, toNumber } from "../util";

/**
 * Google Benchmark (`--benchmark_format=json`).
 *
 * The file interleaves per-iteration rows with aggregate rows (`mean`, `median`, `stddev`)
 * that share a `run_name`. We key off `run_name` so the aggregates fold into the stats of
 * one metric instead of appearing as three separate ones.
 */
export const googleBenchmark: FormatAdapter = {
  id: "google-benchmark",
  label: "Google Benchmark",
  description: "C++ microbenchmarks, folding mean/median/stddev aggregates into one metric.",
  produce: "./bench --benchmark_format=json --benchmark_repetitions=5 > bench.json",

  detect(input) {
    if (!isRecord(input.json)) return false;
    const benchmarks = input.json.benchmarks;
    if (!Array.isArray(benchmarks) || benchmarks.length === 0) return false;
    const first = benchmarks[0];
    return isRecord(first) && "real_time" in first && "time_unit" in first;
  },

  parse(input) {
    if (!isRecord(input.json) || !Array.isArray(input.json.benchmarks)) {
      throw new FormatParseError("Expected a `benchmarks` array", "google-benchmark");
    }

    const metadata: Record<string, unknown> = {};
    if (isRecord(input.json.context)) metadata.context = input.json.context;

    interface Accumulator {
      name: string;
      realMs?: number;
      cpuMs?: number;
      iterations?: number;
      meanMs?: number;
      medianMs?: number;
      stddevMs?: number;
      bytesPerSecond?: number;
      itemsPerSecond?: number;
    }

    const byRun = new Map<string, Accumulator>();

    for (const entry of input.json.benchmarks) {
      if (!isRecord(entry)) continue;
      const runName =
        (typeof entry.run_name === "string" && entry.run_name) ||
        (typeof entry.name === "string" && entry.name) ||
        "benchmark";
      const unit = typeof entry.time_unit === "string" ? entry.time_unit : "ns";
      const realTime = toNumber(entry.real_time);
      const cpuTime = toNumber(entry.cpu_time);
      const realMs = realTime === undefined ? undefined : toMilliseconds(realTime, unit);
      const cpuMs = cpuTime === undefined ? undefined : toMilliseconds(cpuTime, unit);

      const accumulator = byRun.get(runName) ?? { name: runName };
      const aggregate = typeof entry.aggregate_name === "string" ? entry.aggregate_name : null;

      if (aggregate === "mean") accumulator.meanMs = realMs;
      else if (aggregate === "median") accumulator.medianMs = realMs;
      else if (aggregate === "stddev") accumulator.stddevMs = realMs;
      else if (aggregate === null) {
        // Iteration rows repeat; the last one wins, matching how the tool prints them.
        accumulator.realMs = realMs;
        accumulator.cpuMs = cpuMs;
        accumulator.iterations = toNumber(entry.iterations);
        accumulator.bytesPerSecond = toNumber(entry.bytes_per_second);
        accumulator.itemsPerSecond = toNumber(entry.items_per_second);
      }

      byRun.set(runName, accumulator);
    }

    const metrics: Record<string, MetricValue> = {};
    for (const entry of byRun.values()) {
      const value = entry.realMs ?? entry.meanMs;
      if (value === undefined) continue;

      metrics[metricKey("gbench", entry.name, "real_time_ms")] = compactMetric({
        value: precise(value),
        unit: "ms",
        direction: "lower",
        name: entry.name,
        samples: entry.iterations,
        mean: entry.meanMs === undefined ? undefined : precise(entry.meanMs),
        p50: entry.medianMs === undefined ? undefined : precise(entry.medianMs),
        stddev: entry.stddevMs === undefined ? undefined : precise(entry.stddevMs),
      });

      if (entry.cpuMs !== undefined) {
        metrics[metricKey("gbench", entry.name, "cpu_time_ms")] = compactMetric({
          value: precise(entry.cpuMs),
          unit: "ms",
          direction: "lower",
        });
      }
      if (entry.bytesPerSecond !== undefined) {
        metrics[metricKey("gbench", entry.name, "bytes_per_second")] = compactMetric({
          value: precise(entry.bytesPerSecond),
          unit: "bytes/s",
          direction: "higher",
        });
      }
      if (entry.itemsPerSecond !== undefined) {
        metrics[metricKey("gbench", entry.name, "items_per_second")] = compactMetric({
          value: precise(entry.itemsPerSecond),
          unit: "items/s",
          direction: "higher",
        });
      }
    }

    return { format: "google-benchmark", metrics, metadata };
  },
};
