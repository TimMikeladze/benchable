import type { SpanPayload } from "../../schema";

import type { MetricValue } from "../types";
import { compactMetric, precise } from "../util";

/**
 * Shared by the trace adapters (OTLP, Jaeger, Zipkin, Chrome): the spans are the payload, and
 * a few summary metrics are derived so the run still charts, compares and gates like any
 * other run. Timings arrive already rebased per trace — each waterfall starts at zero.
 */
export function summarizeTraceMetrics(spans: readonly SpanPayload[]): Record<string, MetricValue> {
  const totalMs = spans.reduce((max, span) => Math.max(max, span.startMs + span.durationMs), 0);
  const errors = spans.filter((span) => span.status === "error").length;
  const traceCount = new Set(spans.map((span) => span.traceId ?? "")).size;

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
  if (traceCount > 1) {
    metrics["trace.trace_count"] = compactMetric({
      value: traceCount,
      unit: "count",
      direction: "lower",
      name: "Traces",
    });
  }
  return metrics;
}

/** Microseconds — the unit Jaeger, Zipkin and Chrome trace-events all keep time in. */
export function microsToMs(value: number): number {
  return value / 1e3;
}

/**
 * Per-trace rebase: each trace's earliest span becomes its zero, so one payload carrying
 * several traces still renders each waterfall from the left edge rather than stranding the
 * second trace in the middle of the ruler.
 */
export type PendingSpan = Omit<SpanPayload, "startMs"> & { startAbsoluteMs: number };

export function rebasePerTrace(spans: readonly PendingSpan[]): SpanPayload[] {
  const origins = new Map<string, number>();
  for (const span of spans) {
    const key = span.traceId ?? "";
    const current = origins.get(key);
    if (current === undefined || span.startAbsoluteMs < current) origins.set(key, span.startAbsoluteMs);
  }
  return spans.map((span) => {
    const { startAbsoluteMs, ...rest } = span;
    return {
      ...rest,
      startMs: precise(startAbsoluteMs - (origins.get(span.traceId ?? "") ?? startAbsoluteMs)),
    };
  });
}

/** A label for the run: the root operation of a single trace, or the trace count. */
export function traceRunLabel(spans: readonly SpanPayload[]): string {
  const traceIds = new Set(spans.map((span) => span.traceId ?? ""));
  if (traceIds.size > 1) return `${traceIds.size} traces`;
  return spans.find((span) => !span.parentId)?.name ?? spans[0]?.name ?? "trace";
}

/** An error tag, in any of the spellings the ecosystems have settled on. */
export function isErrorTagged(attributes: Record<string, unknown>): boolean {
  const error = attributes["error"];
  if (error === true) return true;
  if (typeof error === "string" && error.length > 0) return true;
  const statusCode = attributes["otel.status_code"] ?? attributes["status.code"];
  return statusCode === "ERROR" || statusCode === "STATUS_CODE_ERROR";
}
