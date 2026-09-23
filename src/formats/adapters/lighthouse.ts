import { FormatParseError, type FormatAdapter, type MetricValue } from "../types";
import {compactMetric, isRecord, metricKey, precise, round, toNumber } from "../util";

/**
 * A Lighthouse JSON report. We take the category scores plus the audits that carry a
 * numeric value — the rest of the report is prose and screenshots.
 */
const AUDIT_DIRECTION: Record<string, "lower" | "higher"> = {
  "first-contentful-paint": "lower",
  "largest-contentful-paint": "lower",
  "speed-index": "lower",
  interactive: "lower",
  "total-blocking-time": "lower",
  "cumulative-layout-shift": "lower",
  "max-potential-fid": "lower",
  "server-response-time": "lower",
  "total-byte-weight": "lower",
};

export const lighthouse: FormatAdapter = {
  id: "lighthouse",
  label: "Lighthouse",
  description: "Category scores and core web vitals from a Lighthouse JSON report.",
  produce: "lighthouse https://example.com --output=json --output-path=lhr.json",

  detect(input) {
    if (!isRecord(input.json)) return false;
    return (
      typeof input.json.lighthouseVersion === "string" &&
      (isRecord(input.json.audits) || isRecord(input.json.categories))
    );
  },

  parse(input) {
    if (!isRecord(input.json)) {
      throw new FormatParseError("Expected a Lighthouse report object", "lighthouse");
    }

    const metrics: Record<string, MetricValue> = {};
    const metadata: Record<string, unknown> = {};
    if (typeof input.json.requestedUrl === "string") metadata.url = input.json.requestedUrl;
    if (typeof input.json.lighthouseVersion === "string") {
      metadata.lighthouseVersion = input.json.lighthouseVersion;
    }

    if (isRecord(input.json.categories)) {
      for (const [id, category] of Object.entries(input.json.categories)) {
        if (!isRecord(category)) continue;
        const score = toNumber(category.score);
        if (score === null || score === undefined) continue;
        metrics[metricKey("lighthouse", id, "score")] = compactMetric({
          // Lighthouse scores are 0–1; 0–100 is how everyone reads them.
          value: round(score * 100, 1),
          unit: "%",
          direction: "higher",
          name: typeof category.title === "string" ? category.title : id,
        });
      }
    }

    if (isRecord(input.json.audits)) {
      for (const [id, audit] of Object.entries(input.json.audits)) {
        if (!isRecord(audit)) continue;
        const numericValue = toNumber(audit.numericValue);
        if (numericValue === undefined) continue;

        const numericUnit = typeof audit.numericUnit === "string" ? audit.numericUnit : undefined;
        const unit =
          numericUnit === "millisecond" ? "ms" : numericUnit === "byte" ? "bytes" : numericUnit;

        metrics[metricKey("lighthouse", id, unit === "ms" ? "ms" : "value")] = compactMetric({
          value: precise(numericValue),
          unit,
          direction: AUDIT_DIRECTION[id] ?? "lower",
          name: typeof audit.title === "string" ? audit.title : id,
        });
      }
    }

    if (Object.keys(metrics).length === 0) {
      throw new FormatParseError("Report had no numeric audits or category scores", "lighthouse");
    }

    return { format: "lighthouse", metrics, metadata };
  },
};
