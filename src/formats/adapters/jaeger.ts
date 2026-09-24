import type { SpanPayload } from "../../schema";

import { FormatParseError, type FormatAdapter } from "../types";
import { isRecord } from "../util";
import {
  isErrorTagged,
  microsToMs,
  rebasePerTrace,
  summarizeTraceMetrics,
  traceRunLabel,
} from "./trace-util";

/**
 * Jaeger's JSON export: `{ data: [{ traceID, spans, processes }] }`. Timings are epoch
 * microseconds; the parent comes from a `CHILD_OF` reference; tags become attributes and the
 * process contributes the service name (and its tags, which a person filters on — host,
 * version, region).
 */
function tagsToRecord(tags: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(tags)) return out;
  for (const tag of tags) {
    if (!isRecord(tag) || typeof tag.key !== "string") continue;
    if ("value" in tag && tag.value !== undefined && tag.value !== null) out[tag.key] = tag.value;
  }
  return out;
}

interface JaegerSpan {
  spanId: string;
  traceId: string;
  parentSpanId: string | null;
  name: string;
  startMs: number;
  durationMs: number;
  attributes: Record<string, unknown>;
  service: string | null;
}

function collectSpans(json: unknown): JaegerSpan[] {
  const out: JaegerSpan[] = [];
  if (!isRecord(json) || !Array.isArray(json.data)) return out;

  for (const trace of json.data) {
    if (!isRecord(trace) || !Array.isArray(trace.spans)) continue;
    const traceId = typeof trace.traceID === "string" && trace.traceID.length > 0 ? trace.traceID : "trace";

    const processes = new Map<string, { serviceName: string; tags: Record<string, unknown> }>();
    if (isRecord(trace.processes)) {
      for (const [processId, process] of Object.entries(trace.processes)) {
        if (!isRecord(process)) continue;
        processes.set(processId, {
          serviceName: typeof process.serviceName === "string" ? process.serviceName : "unknown",
          tags: tagsToRecord(process.tags),
        });
      }
    }

    for (const span of trace.spans) {
      if (!isRecord(span)) continue;
      const spanId = typeof span.spanID === "string" ? span.spanID : undefined;
      const startUs = typeof span.startTime === "number" && Number.isFinite(span.startTime) ? span.startTime : undefined;
      const durationUs = typeof span.duration === "number" && Number.isFinite(span.duration) ? span.duration : undefined;
      if (!spanId || startUs === undefined || durationUs === undefined) continue;

      // `references` carries the parent; CHILD_OF is the nesting edge, FOLLOWS_FROM is not.
      let parentSpanId: string | null = null;
      if (Array.isArray(span.references)) {
        for (const reference of span.references) {
          if (!isRecord(reference) || typeof reference.spanID !== "string") continue;
          if (reference.refType === "FOLLOWS_FROM") continue;
          parentSpanId = reference.spanID;
          break;
        }
      }

      const process = typeof span.processID === "string" ? processes.get(span.processID) : undefined;
      const attributes = { ...process?.tags, ...tagsToRecord(span.tags) };

      out.push({
        spanId,
        traceId,
        parentSpanId,
        name: typeof span.operationName === "string" && span.operationName.length > 0 ? span.operationName : spanId,
        startMs: microsToMs(startUs),
        durationMs: microsToMs(durationUs),
        attributes,
        service: process?.serviceName ?? null,
      });
    }
  }

  return out;
}

export const jaeger: FormatAdapter = {
  id: "jaeger",
  label: "Jaeger traces",
  description: "Jaeger JSON export; becomes trace waterfalls plus summary timings.",
  produce: "Jaeger UI → Share → Download JSON, or `GET /api/traces` from your Jaeger query service.",

  detect(input) {
    if (!isRecord(input.json) || !Array.isArray(input.json.data)) return false;
    const first = input.json.data[0];
    return isRecord(first) && Array.isArray(first.spans);
  },

  parse(input) {
    const raw = collectSpans(input.json);
    if (raw.length === 0) {
      throw new FormatParseError("No spans found in data[].spans", "jaeger");
    }

    const spans = rebasePerTrace(
      raw.map((span) => ({
        id: span.spanId,
        traceId: span.traceId,
        service: span.service ?? undefined,
        parentId: span.parentSpanId,
        name: span.name,
        startAbsoluteMs: span.startMs,
        durationMs: span.durationMs,
        status: isErrorTagged(span.attributes) ? ("error" as const) : ("ok" as const),
        attributes: Object.keys(span.attributes).length > 0 ? span.attributes : undefined,
      })),
    );

    // Jaeger timestamps are epoch microseconds, so the run's start is a real date.
    const startedAtMs = raw.reduce((min, span) => Math.min(min, span.startMs), raw[0].startMs);
    const startedAt = new Date(startedAtMs);

    return {
      format: "jaeger",
      metrics: summarizeTraceMetrics(spans),
      spans,
      label: traceRunLabel(spans),
      startedAt: Number.isFinite(startedAt.getTime()) ? startedAt : undefined,
    };
  },
};
