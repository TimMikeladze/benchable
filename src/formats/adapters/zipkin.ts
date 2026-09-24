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
 * Zipkin v2 JSON: a flat array of spans with epoch-microsecond `timestamp`/`duration`, the
 * trace and parent expressed as `traceId`/`parentId`, and the emitting endpoint under
 * `localEndpoint.serviceName`.
 *
 * Zipkin lets a client and its server share one span id (`shared: true` marks the server
 * half). Ingest keeps the first span per id, so the client half — the one that owns the
 * timing — survives and the duplicate is folded away rather than corrupting the tree.
 */
function tagsToRecord(tags: unknown): Record<string, unknown> {
  if (!isRecord(tags)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

interface ZipkinSpan {
  spanId: string;
  traceId: string;
  parentSpanId: string | null;
  name: string;
  startMs: number;
  durationMs: number;
  attributes: Record<string, unknown>;
  service: string | null;
}

function collectSpans(json: unknown): ZipkinSpan[] {
  const out: ZipkinSpan[] = [];
  if (!Array.isArray(json)) return out;

  for (const span of json) {
    if (!isRecord(span)) continue;
    const spanId = typeof span.id === "string" && span.id.length > 0 ? span.id : undefined;
    const traceId = typeof span.traceId === "string" && span.traceId.length > 0 ? span.traceId : undefined;
    const timestampUs =
      typeof span.timestamp === "number" && Number.isFinite(span.timestamp) ? span.timestamp : undefined;
    if (!spanId || !traceId || timestampUs === undefined) continue;

    const durationUs =
      typeof span.duration === "number" && Number.isFinite(span.duration) ? span.duration : 0;
    const parentSpanId =
      typeof span.parentId === "string" && span.parentId.length > 0 ? span.parentId : null;

    const attributes = tagsToRecord(span.tags);
    const local = isRecord(span.localEndpoint) ? span.localEndpoint : undefined;
    const service = typeof local?.serviceName === "string" && local.serviceName.length > 0 ? local.serviceName : null;
    // The far end of the call — the database a query went to, the service an RPC hit.
    const remote = isRecord(span.remoteEndpoint) ? span.remoteEndpoint : undefined;
    if (typeof remote?.serviceName === "string" && remote.serviceName.length > 0) {
      attributes["peer.service"] ??= remote.serviceName;
    }

    out.push({
      spanId,
      traceId,
      parentSpanId,
      name: typeof span.name === "string" && span.name.length > 0 ? span.name : spanId,
      startMs: microsToMs(timestampUs),
      durationMs: microsToMs(durationUs),
      attributes,
      service,
    });
  }

  return out;
}

export const zipkin: FormatAdapter = {
  id: "zipkin",
  label: "Zipkin traces",
  description: "Zipkin v2 JSON; becomes trace waterfalls plus summary timings.",
  produce: "`GET /api/v2/traces` from your Zipkin server, or POST /api/v2/spans output.",

  detect(input) {
    if (!Array.isArray(input.json) || input.json.length === 0) return false;
    const first = input.json[0];
    return isRecord(first) && typeof first.traceId === "string" && typeof first.id === "string";
  },

  parse(input) {
    const raw = collectSpans(input.json);
    if (raw.length === 0) {
      throw new FormatParseError("No spans found; expected a Zipkin v2 JSON array", "zipkin");
    }

    // Zipkin lets a client and its server share one span id. The client half owns the timing,
    // so the first span per id wins and the shared duplicates are folded here — every
    // consumer (run ingest, local report, MCP) then sees one consistent tree.
    const seen = new Set<string>();
    const unique = raw.filter((span) => (seen.has(span.spanId) ? false : (seen.add(span.spanId), true)));

    const spans = rebasePerTrace(
      unique.map((span) => ({
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

    // Zipkin timestamps are epoch microseconds, so the run's start is a real date.
    const startedAtMs = unique.reduce((min, span) => Math.min(min, span.startMs), unique[0].startMs);
    const startedAt = new Date(startedAtMs);

    return {
      format: "zipkin",
      metrics: summarizeTraceMetrics(spans),
      spans,
      label: traceRunLabel(spans),
      startedAt: Number.isFinite(startedAt.getTime()) ? startedAt : undefined,
    };
  },
};
