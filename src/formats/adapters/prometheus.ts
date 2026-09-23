import { FormatParseError, type FormatAdapter, type MetricValue } from "../types";
import {compactMetric, metricKey, precise, round } from "../util";

/**
 * Prometheus text exposition format — the body of a `/metrics` scrape.
 *
 * Quantile and histogram bucket labels are folded into one metric's percentiles rather than
 * becoming separate series, because "p95 of request duration" is one benchmark, not four.
 */
const SAMPLE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+([^\s]+)(?:\s+\d+)?$/;

function parseLabels(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const inner = raw.slice(1, -1);
  const labels: Record<string, string> = {};
  // Values may contain escaped quotes and commas, so match pairs rather than splitting.
  const pair = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pair.exec(inner)) !== null) {
    labels[match[1]] = match[2].replace(/\\(["\\n])/g, (_, c) => (c === "n" ? "\n" : c));
  }
  return labels;
}

function parseValue(raw: string): number | undefined {
  if (raw === "+Inf") return Number.POSITIVE_INFINITY;
  if (raw === "-Inf") return Number.NEGATIVE_INFINITY;
  if (raw === "NaN") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

const LOWER_IS_BETTER = /(duration|latency|seconds|bytes|errors|failures|time)/i;

export const prometheus: FormatAdapter = {
  id: "prometheus",
  label: "Prometheus",
  description: "A /metrics scrape in text exposition format; quantiles fold into percentiles.",
  produce: "curl -s http://localhost:9090/metrics > metrics.txt",

  detect(input) {
    if (input.json !== null) return false;
    const lines = input.raw.split("\n");
    const hasTypeHeader = lines.some((line) => /^#\s*TYPE\s+\S+\s+\S+/.test(line.trim()));
    const hasSample = lines.some((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith("#") && SAMPLE.test(trimmed);
    });
    return hasTypeHeader && hasSample;
  },

  parse(input) {
    interface Series {
      base: string;
      labels: Record<string, string>;
      value: number;
      quantile?: number;
    }

    const series: Series[] = [];
    const help: Record<string, string> = {};

    for (const rawLine of input.raw.split("\n")) {
      const line = rawLine.trim();
      if (line === "") continue;
      if (line.startsWith("#")) {
        const helpMatch = /^#\s*HELP\s+(\S+)\s+(.*)$/.exec(line);
        if (helpMatch) help[helpMatch[1]] = helpMatch[2];
        continue;
      }

      const match = SAMPLE.exec(line);
      if (!match) continue;
      const value = parseValue(match[3]);
      if (value === undefined || !Number.isFinite(value)) continue;

      const labels = parseLabels(match[2]);
      const quantile = labels.quantile === undefined ? undefined : Number(labels.quantile);
      // Histogram buckets are cumulative counts, not a benchmark value. Test the parsed
      // label rather than the raw string — "quantile=" contains "le=".
      const isBucket = "le" in labels;
      delete labels.quantile;
      delete labels.le;

      if (isBucket) continue;

      series.push({ base: match[1], labels, value, quantile });
    }

    if (series.length === 0) {
      throw new FormatParseError("No samples found", "prometheus");
    }

    // Group by metric name plus its non-quantile labels, so quantiles collapse into one entry.
    interface Group {
      base: string;
      labels: Record<string, string>;
      value?: number;
      quantiles: Map<number, number>;
    }
    const grouped = new Map<string, Group>();
    for (const entry of series) {
      const labelKey = Object.entries(entry.labels)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(",");
      const groupKey = `${entry.base}|${labelKey}`;
      const group: Group =
        grouped.get(groupKey) ?? { base: entry.base, labels: entry.labels, quantiles: new Map() };
      if (entry.quantile === undefined) group.value = entry.value;
      else group.quantiles.set(entry.quantile, entry.value);
      grouped.set(groupKey, group);
    }

    const metrics: Record<string, MetricValue> = {};
    for (const group of grouped.values()) {
      const quantiles = group.quantiles;
      const value = group.value ?? quantiles.get(0.5) ?? [...quantiles.values()][0];
      if (value === undefined) continue;

      const labelSuffix = Object.entries(group.labels)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}_${v}`)
        .join(".");

      metrics[metricKey("prom", group.base, labelSuffix)] = compactMetric({
        value: precise(value),
        direction: LOWER_IS_BETTER.test(group.base) ? "lower" : "higher",
        name: help[group.base] ?? group.base,
        p50: quantiles.get(0.5),
        p95: quantiles.get(0.95),
        p99: quantiles.get(0.99),
        labels: Object.keys(group.labels).length > 0 ? group.labels : undefined,
      });
    }

    return { format: "prometheus", metrics };
  },
};
