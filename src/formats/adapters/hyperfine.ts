import { FormatParseError, type FormatAdapter, type MetricValue } from "../types";
import {compactMetric, isRecord, metricKey, precise, round, toNumber } from "../util";

/**
 * `hyperfine --export-json`. Every duration in the file is in seconds; we store milliseconds
 * so a hyperfine metric sits on the same axis as everything else that measures time.
 */
export const hyperfine: FormatAdapter = {
  id: "hyperfine",
  label: "hyperfine",
  description: "Command-line benchmark timings from hyperfine, with mean, stddev, min and max.",
  produce: "hyperfine --export-json bench.json './build.sh'",

  detect(input) {
    if (!isRecord(input.json)) return false;
    const results = input.json.results;
    if (!Array.isArray(results) || results.length === 0) return false;
    const first = results[0];
    return isRecord(first) && "command" in first && "mean" in first;
  },

  parse(input) {
    if (!isRecord(input.json) || !Array.isArray(input.json.results)) {
      throw new FormatParseError("Expected a `results` array", "hyperfine");
    }

    const metrics: Record<string, MetricValue> = {};
    for (const entry of input.json.results) {
      if (!isRecord(entry)) continue;
      const command = typeof entry.command === "string" ? entry.command : "command";
      const mean = toNumber(entry.mean);
      if (mean === undefined) continue;

      const seconds = (value: unknown) => {
        const n = toNumber(value);
        return n === undefined ? undefined : precise(n * 1000);
      };

      metrics[metricKey("hyperfine", command, "mean_ms")] = compactMetric({
        value: precise(mean * 1000),
        unit: "ms",
        direction: "lower",
        name: command,
        min: seconds(entry.min),
        max: seconds(entry.max),
        mean: precise(mean * 1000),
        p50: seconds(entry.median),
        stddev: seconds(entry.stddev),
        samples: Array.isArray(entry.times) ? entry.times.length : undefined,
        values: Array.isArray(entry.times)
          ? entry.times.map(toNumber).filter((n): n is number => n !== undefined).map((n) => precise(n * 1000))
          : undefined,
      });

      const user = seconds(entry.user);
      if (user !== undefined) {
        metrics[metricKey("hyperfine", command, "user_ms")] = compactMetric({
          value: user,
          unit: "ms",
          direction: "lower",
        });
      }
      const system = seconds(entry.system);
      if (system !== undefined) {
        metrics[metricKey("hyperfine", command, "system_ms")] = compactMetric({
          value: system,
          unit: "ms",
          direction: "lower",
        });
      }
    }

    return { format: "hyperfine", metrics };
  },
};
