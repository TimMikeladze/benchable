import type { SpanPayload } from "../../schema";

import { FormatParseError, type FormatAdapter } from "../types";
import { isRecord, precise } from "../util";
import { summarizeTraceMetrics, traceRunLabel } from "./trace-util";

/**
 * OTLP/JSON trace export (`ResourceSpans`). This is the one adapter that produces spans
 * rather than metrics: the trace itself is the payload, and we derive a small number of
 * summary metrics from it so the run still has something to chart.
 *
 * An export can carry many traces — a collector batches what it saw — so each span keeps its
 * `traceId` and the service name from its resource, and timings are rebased **per trace** so
 * every waterfall starts at zero no matter what it shares the payload with.
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
  traceId: string | null;
  parentSpanId: string | null;
  name: string;
  start: bigint;
  end: bigint;
  status: "ok" | "error";
  attributes: Record<string, unknown>;
  service: string | null;
}

function collectSpans(json: unknown): RawSpan[] {
  const out: RawSpan[] = [];
  if (!isRecord(json) || !Array.isArray(json.resourceSpans)) return out;

  for (const resourceSpan of json.resourceSpans) {
    if (!isRecord(resourceSpan)) continue;
    const resource = isRecord(resourceSpan.resource)
      ? attributesToRecord(resourceSpan.resource.attributes)
      : {};
    const service = typeof resource["service.name"] === "string" ? resource["service.name"] : null;
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
        const traceId = typeof span.traceId === "string" && span.traceId.length > 0 ? span.traceId : null;

        out.push({
          spanId,
          traceId,
          parentSpanId: parent,
          name: typeof span.name === "string" ? span.name : spanId,
          start,
          end,
          // OTLP status: 0 UNSET, 1 OK, 2 ERROR.
          status: statusCode === 2 || statusCode === "STATUS_CODE_ERROR" ? "error" : "ok",
          attributes: attributesToRecord(span.attributes),
          service,
        });
      }
    }
  }

  return out;
}

/** The earliest start of each trace, so every trace can be rebased to its own zero. */
function traceOrigins(raw: readonly RawSpan[]): Map<string | null, bigint> {
  const origins = new Map<string | null, bigint>();
  for (const span of raw) {
    const current = origins.get(span.traceId);
    if (current === undefined || span.start < current) origins.set(span.traceId, span.start);
  }
  return origins;
}

export const otlpTrace: FormatAdapter = {
  id: "otlp-trace",
  label: "OpenTelemetry traces",
  description: "OTLP/JSON ResourceSpans; becomes trace waterfalls plus summary timings.",
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

    const origins = traceOrigins(raw);
    const nanosToMs = (value: bigint) => Number(value) / 1e6;

    const spans: SpanPayload[] = raw.map((span) => ({
      id: span.spanId,
      traceId: span.traceId ?? undefined,
      service: span.service ?? undefined,
      parentId: span.parentSpanId,
      name: span.name,
      startMs: precise(nanosToMs(span.start - (origins.get(span.traceId) ?? span.start))),
      durationMs: precise(nanosToMs(span.end - span.start)),
      status: span.status,
      attributes: Object.keys(span.attributes).length > 0 ? span.attributes : undefined,
    }));

    const label = traceRunLabel(spans);
    const startedAt = new Date(
      Number(raw.reduce((min, span) => (span.start < min ? span.start : min), raw[0].start) / 1_000_000n),
    );

    return {
      format: "otlp-trace",
      metrics: summarizeTraceMetrics(spans),
      spans,
      label,
      startedAt: Number.isFinite(startedAt.getTime()) ? startedAt : undefined,
    };
  },
};
