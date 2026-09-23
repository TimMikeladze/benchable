import { FormatParseError, type FormatAdapter, type MetricValue } from "../types";
import {compactMetric, isRecord, metricKey, precise, round, toNumber } from "../util";

/**
 * JMH `-rf json`. The array is one object per benchmark, and `mode` decides the direction:
 * `thrpt` counts operations (higher is better), everything else measures time.
 */
export const jmh: FormatAdapter = {
  id: "jmh",
  label: "JMH",
  description: "Java microbenchmarks from JMH, with score error and percentiles.",
  produce: "java -jar benchmarks.jar -rf json -rff bench.json",

  detect(input) {
    if (!Array.isArray(input.json) || input.json.length === 0) return false;
    const first = input.json[0];
    return isRecord(first) && "benchmark" in first && isRecord(first.primaryMetric);
  },

  parse(input) {
    if (!Array.isArray(input.json)) {
      throw new FormatParseError("Expected an array of benchmark results", "jmh");
    }

    const metrics: Record<string, MetricValue> = {};
    for (const entry of input.json) {
      if (!isRecord(entry) || !isRecord(entry.primaryMetric)) continue;
      const name = typeof entry.benchmark === "string" ? entry.benchmark : "benchmark";
      const primary = entry.primaryMetric;
      const score = toNumber(primary.score);
      if (score === undefined) continue;

      const scoreUnit = typeof primary.scoreUnit === "string" ? primary.scoreUnit : "ops/s";
      const mode = typeof entry.mode === "string" ? entry.mode : "avgt";
      const direction = mode === "thrpt" ? ("higher" as const) : ("lower" as const);

      const percentiles = isRecord(primary.scorePercentiles) ? primary.scorePercentiles : {};
      const rawData = Array.isArray(primary.rawData) ? primary.rawData.flat() : [];

      metrics[metricKey("jmh", name, scoreUnit.replace("/", "_per_"))] = compactMetric({
        value: precise(score),
        unit: scoreUnit,
        direction,
        name,
        stddev: toNumber(primary.scoreError),
        min: toNumber(percentiles["0.0"]),
        max: toNumber(percentiles["100.0"]),
        p50: toNumber(percentiles["50.0"]),
        p95: toNumber(percentiles["95.0"]),
        p99: toNumber(percentiles["99.0"]),
        samples: rawData.length || undefined,
        labels: { mode },
      });
    }

    if (Object.keys(metrics).length === 0) {
      throw new FormatParseError("No benchmarks with a primary metric", "jmh");
    }

    return { format: "jmh", metrics };
  },
};
