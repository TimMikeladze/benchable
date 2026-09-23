import { FormatParseError, type FormatAdapter, type MetricValue } from "../types";
import {compactMetric, isRecord, metricKey, precise, round, toNumber } from "../util";

/**
 * `k6 run --summary-export=summary.json`.
 *
 * k6 metrics come in three shapes — trends (avg/min/med/max/percentiles), counters
 * (count/rate) and gauges (value) — so each maps to a different primary value.
 */
const LOWER_IS_BETTER = /(duration|waiting|blocked|connecting|sending|receiving|failed|dropped|error)/i;

export const k6: FormatAdapter = {
  id: "k6",
  label: "k6",
  description: "Load-test summary from k6, with request percentiles, rates and check counts.",
  produce: "k6 run --summary-export=summary.json script.js",

  detect(input) {
    if (!isRecord(input.json) || !isRecord(input.json.metrics)) return false;
    const metrics = input.json.metrics;
    return (
      "http_req_duration" in metrics ||
      "iterations" in metrics ||
      "vus" in metrics ||
      "checks" in metrics
    );
  },

  parse(input) {
    if (!isRecord(input.json) || !isRecord(input.json.metrics)) {
      throw new FormatParseError("Expected a `metrics` object", "k6");
    }

    const metrics: Record<string, MetricValue> = {};
    for (const [name, entry] of Object.entries(input.json.metrics)) {
      if (!isRecord(entry)) continue;

      const avg = toNumber(entry.avg);
      const count = toNumber(entry.count);
      const gauge = toNumber(entry.value);
      const rate = toNumber(entry.rate);

      const isDuration = /duration|waiting|blocked|connecting|sending|receiving|tls_handshaking/.test(name);
      const direction = LOWER_IS_BETTER.test(name) ? ("lower" as const) : ("higher" as const);

      if (avg !== undefined) {
        metrics[metricKey("k6", name, "avg")] = compactMetric({
          value: precise(avg),
          unit: isDuration ? "ms" : undefined,
          direction,
          name,
          min: toNumber(entry.min),
          max: toNumber(entry.max),
          mean: precise(avg),
          p50: toNumber(entry.med),
          p95: toNumber(entry["p(95)"]),
          p99: toNumber(entry["p(99)"]),
        });
      } else if (count !== undefined) {
        metrics[metricKey("k6", name, "count")] = compactMetric({
          value: precise(count),
          unit: "count",
          direction,
          name,
        });
      } else if (gauge !== undefined) {
        metrics[metricKey("k6", name, "value")] = compactMetric({
          value: precise(gauge),
          direction,
          name,
        });
      }

      if (rate !== undefined) {
        metrics[metricKey("k6", name, "rate")] = compactMetric({
          value: precise(rate),
          unit: "/s",
          direction,
        });
      }
    }

    if (Object.keys(metrics).length === 0) {
      throw new FormatParseError("No usable metrics in the summary", "k6");
    }

    return { format: "k6", metrics };
  },
};
