import { FormatParseError, type FormatAdapter, type MetricValue } from "../types";
import {compactMetric, isRecord, metricKey, precise, round, toNumber } from "../util";

/**
 * `vitest bench --outputJson`, which is tinybench's task results wrapped in files and groups.
 * Durations are already in milliseconds.
 */
interface Benchmark {
  name: string;
  file?: string;
  group?: string;
  record: Record<string, unknown>;
}

function collect(json: unknown): Benchmark[] {
  const out: Benchmark[] = [];

  const pushTask = (record: unknown, file?: string, group?: string) => {
    if (!isRecord(record)) return;
    const name = typeof record.name === "string" ? record.name : undefined;
    if (!name) return;
    // Vitest nests the numbers under `result`; bare tinybench puts them on the task.
    const stats = isRecord(record.result) ? record.result : record;
    out.push({ name, file, group, record: stats });
  };

  if (Array.isArray(json)) {
    for (const entry of json) pushTask(entry);
    return out;
  }

  if (!isRecord(json)) return out;

  if (Array.isArray(json.files)) {
    for (const file of json.files) {
      if (!isRecord(file)) continue;
      const filepath = typeof file.filepath === "string" ? file.filepath : undefined;
      const groups = Array.isArray(file.groups) ? file.groups : [];
      for (const group of groups) {
        if (!isRecord(group)) continue;
        const groupName = typeof group.fullName === "string" ? group.fullName : undefined;
        const benchmarks = Array.isArray(group.benchmarks) ? group.benchmarks : [];
        for (const benchmark of benchmarks) pushTask(benchmark, filepath, groupName);
      }
    }
  }

  if (Array.isArray(json.benchmarks)) {
    for (const benchmark of json.benchmarks) pushTask(benchmark);
  }

  return out;
}

export const vitestBench: FormatAdapter = {
  id: "vitest-bench",
  label: "Vitest / tinybench",
  description: "JavaScript microbenchmarks from `vitest bench --outputJson`, or raw tinybench.",
  produce: "vitest bench --outputJson=bench.json",

  detect(input) {
    if (input.json === null) return false;
    const found = collect(input.json);
    if (found.length === 0) return false;
    // `hz` is tinybench's signature field and is what separates this from other JSON shapes.
    return found.some((entry) => toNumber(entry.record.hz) !== undefined);
  },

  parse(input) {
    const found = collect(input.json);
    if (found.length === 0) {
      throw new FormatParseError("No benchmark tasks found", "vitest-bench");
    }

    const metrics: Record<string, MetricValue> = {};
    for (const entry of found) {
      const record = entry.record;
      const mean = toNumber(record.mean);
      const hz = toNumber(record.hz);
      const labels: Record<string, string> = {};
      if (entry.file) labels.file = entry.file;
      if (entry.group) labels.group = entry.group;

      if (mean !== undefined) {
        metrics[metricKey("vitest", entry.name, "mean_ms")] = compactMetric({
          value: precise(mean),
          unit: "ms",
          direction: "lower",
          name: entry.name,
          min: toNumber(record.min),
          max: toNumber(record.max),
          mean: precise(mean),
          p50: toNumber(record.p50) ?? toNumber(record.median),
          p99: toNumber(record.p99),
          stddev: toNumber(record.sd) ?? toNumber(record.stddev),
          samples: toNumber(record.sampleCount) ?? toNumber(record.samples),
          labels: Object.keys(labels).length > 0 ? labels : undefined,
        });
      }

      if (hz !== undefined) {
        metrics[metricKey("vitest", entry.name, "hz")] = compactMetric({
          value: precise(hz),
          unit: "ops/s",
          direction: "higher",
          name: `${entry.name} throughput`,
        });
      }
    }

    return { format: "vitest-bench", metrics };
  },
};
