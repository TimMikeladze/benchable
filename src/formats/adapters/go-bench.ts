import type { FormatAdapter, MetricValue } from "../types";
import {compactMetric, metricKey, precise, round } from "../util";

/**
 * `go test -bench=. -benchmem` text output.
 *
 * ```
 * goos: darwin
 * BenchmarkEncode-10   1000000   1053 ns/op   512 B/op   4 allocs/op
 * ```
 *
 * The trailing `-10` is GOMAXPROCS, not part of the benchmark name, so it moves to a label
 * rather than fragmenting the metric key across machines with different core counts.
 */
const BENCH_LINE = /^(Benchmark[^\s]*?)(?:-(\d+))?\s+(\d+)\s+(.*)$/;
const MEASURE = /([\d.eE+-]+)\s+([^\s]+)/g;

const UNIT_SPEC: Record<string, { unit: string; direction: "lower" | "higher" }> = {
  "ns/op": { unit: "ns", direction: "lower" },
  "B/op": { unit: "bytes", direction: "lower" },
  "allocs/op": { unit: "allocs", direction: "lower" },
  "MB/s": { unit: "MB/s", direction: "higher" },
  "bytes/op": { unit: "bytes", direction: "lower" },
};

export const goBench: FormatAdapter = {
  id: "go-bench",
  label: "Go benchmarks",
  description: "Text output from `go test -bench`, including -benchmem counters.",
  produce: "go test -bench=. -benchmem ./... | tee bench.txt",

  detect(input) {
    if (input.json !== null) return false;
    return input.raw.split("\n").some((line) => BENCH_LINE.test(line.trim()));
  },

  parse(input) {
    const metrics: Record<string, MetricValue> = {};
    const metadata: Record<string, unknown> = {};
    // `-count=N` repeats every line; each repetition is one sample of the same metric.
    const repeats: Record<string, number[]> = {};

    for (const rawLine of input.raw.split("\n")) {
      const line = rawLine.trim();

      const header = /^(goos|goarch|pkg|cpu):\s*(.+)$/.exec(line);
      if (header) {
        metadata[header[1]] = header[2].trim();
        continue;
      }

      const match = BENCH_LINE.exec(line);
      if (!match) continue;

      const [, name, procs, iterations, rest] = match;
      const labels = procs ? { procs } : undefined;

      MEASURE.lastIndex = 0;
      let measure: RegExpExecArray | null;
      while ((measure = MEASURE.exec(rest)) !== null) {
        const value = Number(measure[1]);
        if (!Number.isFinite(value)) continue;
        const rawUnit = measure[2];
        const spec = UNIT_SPEC[rawUnit] ?? { unit: rawUnit, direction: "lower" as const };

        const key = metricKey("go", name, rawUnit.replace("/", "_per_"));
        (repeats[key] ??= []).push(precise(value));
        metrics[key] = compactMetric({
          value: precise(value),
          unit: spec.unit,
          direction: spec.direction,
          samples: Number(iterations),
          name: `${name} ${rawUnit}`,
          labels,
        });
      }
    }

    for (const [key, values] of Object.entries(repeats)) {
      if (values.length < 2) continue;
      const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
      metrics[key] = compactMetric({
        ...metrics[key],
        value: precise(mean),
        mean: precise(mean),
        samples: values.length,
        values,
      });
    }

    return { format: "go-bench", metrics, metadata };
  },
};
