import type { SpanPayload } from "../../schema";

import { FormatParseError, type FormatAdapter, type MetricValue } from "../types";
import {compactMetric, isRecord, precise, round } from "../util";

/**
 * OTLP/JSON trace export (`ResourceSpans`). This is the one adapter that produces spans
 * rather than metrics: the trace itself is the payload, and we derive a small number of
 * summary metrics from it so the run still has something to chart.
 *
 * Timestamps are nanosecond strings (they exceed Number.MAX_SAFE_INTEGER), so the arithmetic
 * is done in BigInt and only the millisecond offset is converted to a number.
 */
function toBigInt(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  return undefined;
}

function attributeValue(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  if ("stringValue" in value) return value.stringValue;
  if ("intValue" in value) return Number(value.intValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("boolValue" in value) return value.boolValue;
  if ("arrayValue" in value && isRecord(value.arrayValue) && Array.isArray(value.arrayValue.values)) {
    return value.arrayValue.values.map(attributeValue);
  }
  return undefined;
}

function attributesToRecord(attributes: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(attributes)) return out;
  for (const attribute of attributes) {
    if (!isRecord(attribute) || typeof attribute.key !== "string") continue;
    const value = attributeValue(attribute.value);
    if (value !== undefined) out[attribute.key] = value;
  }
  return out;
}

interface RawSpan {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  start: bigint;
  end: bigint;
  status: "ok" | "error";
  attributes: Record<string, unknown>;
}

function collectSpans(json: unknown): RawSpan[] {
  const out: RawSpan[] = [];
  if (!isRecord(json) || !Array.isArray(json.resourceSpans)) return out;

  for (const resourceSpan of json.resourceSpans) {
    if (!isRecord(resourceSpan)) continue;
    const scopeSpans = Array.isArray(resourceSpan.scopeSpans)
      ? resourceSpan.scopeSpans
      : Array.isArray(resourceSpan.instrumentationLibrarySpans)
        ? resourceSpan.instrumentationLibrarySpans
        : [];

    for (const scopeSpan of scopeSpans) {
      if (!isRecord(scopeSpan) || !Array.isArray(scopeSpan.spans)) continue;
      for (const span of scopeSpan.spans) {
        if (!isRecord(span)) continue;
        const start = toBigInt(span.startTimeUnixNano);
        const end = toBigInt(span.endTimeUnixNano);
        const spanId = typeof span.spanId === "string" ? span.spanId : undefined;
        if (start === undefined || end === undefined || !spanId) continue;

        const parent =
          typeof span.parentSpanId === "string" && span.parentSpanId.length > 0
            ? span.parentSpanId
            : null;
        const statusCode = isRecord(span.status) ? span.status.code : undefined;

        out.push({
          spanId,
          parentSpanId: parent,
          name: typeof span.name === "string" ? span.name : spanId,
          start,
          end,
          // OTLP status: 0 UNSET, 1 OK, 2 ERROR.
          status: statusCode === 2 || statusCode === "STATUS_CODE_ERROR" ? "error" : "ok",
          attributes: attributesToRecord(span.attributes),
        });
      }
    }
  }

  return out;
}

export const otlpTrace: FormatAdapter = {
  id: "otlp-trace",
  label: "OpenTelemetry traces",
  description: "OTLP/JSON ResourceSpans; becomes a trace waterfall plus summary timings.",
  produce: "Export OTLP/JSON from your collector, or POST the payload your app already sends.",

  detect(input) {
    if (!isRecord(input.json)) return false;
    return Array.isArray(input.json.resourceSpans);
  },

  parse(input) {
    const raw = collectSpans(input.json);
    if (raw.length === 0) {
      throw new FormatParseError("No spans found in resourceSpans", "otlp-trace");
    }

    const origin = raw.reduce((min, span) => (span.start < min ? span.start : min), raw[0].start);
    const nanosToMs = (value: bigint) => Number(value) / 1e6;

    const spans: SpanPayload[] = raw.map((span) => ({
      id: span.spanId,
      parentId: span.parentSpanId,
      name: span.name,
      startMs: precise(nanosToMs(span.start - origin)),
      durationMs: precise(nanosToMs(span.end - span.start)),
      status: span.status,
      attributes: Object.keys(span.attributes).length > 0 ? span.attributes : undefined,
    }));

    const totalMs = spans.reduce((max, span) => Math.max(max, span.startMs + span.durationMs), 0);
    const errors = spans.filter((span) => span.status === "error").length;
    const roots = raw.filter((span) => span.parentSpanId === null);

    const metrics: Record<string, MetricValue> = {
      "trace.total_ms": compactMetric({
        value: precise(totalMs),
        unit: "ms",
        direction: "lower",
        name: "Trace wall time",
      }),
      "trace.span_count": compactMetric({
        value: spans.length,
        unit: "count",
        direction: "lower",
        name: "Spans",
      }),
      "trace.error_spans": compactMetric({
        value: errors,
        unit: "count",
        direction: "lower",
        name: "Spans that errored",
      }),
    };

    const label = roots[0]?.name;
    const startedAt = new Date(Number(origin / 1_000_000n));

    return {
      format: "otlp-trace",
      metrics,
      spans,
      label,
      startedAt: Number.isFinite(startedAt.getTime()) ? startedAt : undefined,
    };
  },
};
