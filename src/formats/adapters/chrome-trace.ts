import type { SpanPayload } from "../../schema";

import { FormatParseError, type FormatAdapter } from "../types";
import { isRecord } from "../util";
import { microsToMs, rebasePerTrace, summarizeTraceMetrics } from "./trace-util";

/**
 * Chrome DevTools / Perfetto trace-events JSON: `{traceEvents: [...]}` (or a bare array).
 * Timings are microseconds; duration comes either complete (`ph:"X"` carries `dur`) or from
 * matched `B`/`E` pairs, which nest per `(pid, tid)` stack.
 *
 * The whole file is one trace: DevTools shows processes and threads of a single page load
 * together, so spans keep `traceId` unset and render as parallel roots. Thread and process
 * names arrive as `ph:"M"` metadata events and become the service (`process_name`) and a
 * `thread.name` attribute.
 */

interface OpenEvent {
  id: string;
  name: string;
  ts: number;
}

interface CollectedSpan {
  id: string;
  parentId: string | null;
  name: string;
  startMs: number;
  durationMs: number;
  attributes: Record<string, unknown>;
  service: string | null;
}

function collectEvents(events: readonly unknown[]): CollectedSpan[] {
  // B/E matching needs time order; Chrome exports sorted but a hand-edited file may not be.
  const eventTsOf = (event: unknown) => (isRecord(event) ? eventTs(event) : NaN);
  const ordered = [...events].sort((a, b) => eventTsOf(a) - eventTsOf(b));

  const processNames = new Map<number, string>();
  const threadNames = new Map<string, string>();
  const out: CollectedSpan[] = [];
  // One open-event stack per (pid, tid); a span's parent is whatever is open beneath it.
  const stacks = new Map<string, OpenEvent[]>();
  let seq = 0;

  for (const event of ordered) {
    if (!isRecord(event)) continue;
    const ts = eventTs(event);
    const pid = event.pid;
    const tid = event.tid;
    const name = typeof event.name === "string" ? event.name : "event";
    const ph = typeof event.ph === "string" ? event.ph : "";

    if (ph === "M") {
      // Metadata: process_name and thread_name label the rows a person navigates by. These
      // carry no timestamp of their own.
      const value = isRecord(event.args) ? event.args.name : undefined;
      if (typeof value !== "string") continue;
      if (name === "process_name" && typeof pid === "number") processNames.set(pid, value);
      if (name === "thread_name" && typeof pid === "number" && typeof tid === "number") {
        threadNames.set(`${pid}:${tid}`, value);
      }
      continue;
    }

    if (!Number.isFinite(ts) || typeof pid !== "number" || typeof tid !== "number") continue;
    const stackKey = `${pid}:${tid}`;
    const stack = stacks.get(stackKey) ?? [];
    stacks.set(stackKey, stack);

    if (ph === "X") {
      const dur = typeof event.dur === "number" && Number.isFinite(event.dur) ? event.dur : 0;
      out.push(
        toSpan(event, name, ts, dur, stack, pid, tid, threadNames, processNames, () => `${pid}-${tid}-${seq++}`),
      );
      continue;
    }

    if (ph === "B" || ph === "b") {
      const id = `${pid}-${tid}-${seq++}`;
      stack.push({ id, name, ts });
      continue;
    }

    if (ph === "E" || ph === "e") {
      // Pop the matching begin; an unmatched E (dropped B, async pair) is skipped rather
      // than corrupting a neighbour's duration.
      let index = -1;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.name === name) {
          index = i;
          break;
        }
      }
      if (index === -1) continue;
      const open = stack.splice(index)[0]!;
      out.push(
        toSpan(event, name, open.ts, ts - open.ts, stack, pid, tid, threadNames, processNames, () => open.id),
      );
    }
  }

  return out;
}

function eventTs(event: Record<string, unknown>): number {
  return typeof event.ts === "number" && Number.isFinite(event.ts)
    ? event.ts
    : typeof event.ts === "string" && event.ts.trim() !== "" && Number.isFinite(Number(event.ts))
      ? Number(event.ts)
      : NaN;
}

function toSpan(
  event: Record<string, unknown>,
  name: string,
  ts: number,
  durUs: number,
  stack: readonly OpenEvent[],
  pid: number,
  tid: number,
  threadNames: ReadonlyMap<string, string>,
  processNames: ReadonlyMap<number, string>,
  allocId: () => string,
): CollectedSpan {
  const attributes: Record<string, unknown> = {};
  if (isRecord(event.args)) Object.assign(attributes, event.args);
  if (typeof event.cat === "string" && event.cat.length > 0) attributes.cat = event.cat;
  const threadName = threadNames.get(`${pid}:${tid}`);
  if (threadName) attributes["thread.name"] = threadName;

  return {
    id: allocId(),
    parentId: stack.length > 0 ? stack[stack.length - 1]!.id : null,
    name,
    startMs: microsToMs(ts),
    durationMs: Math.max(0, microsToMs(durUs)),
    attributes,
    service: processNames.get(pid) ?? null,
  };
}

function eventsOf(json: unknown): unknown[] | null {
  if (Array.isArray(json)) return json;
  if (isRecord(json) && Array.isArray(json.traceEvents)) return json.traceEvents;
  return null;
}

export const chromeTrace: FormatAdapter = {
  id: "chrome-trace",
  label: "Chrome / Perfetto traces",
  description: "Trace-events JSON (DevTools Performance, Perfetto); becomes a trace waterfall.",
  produce: "DevTools → Performance → record → Export JSON, or Perfetto's trace-events JSON.",

  detect(input) {
    const events = eventsOf(input.json);
    if (!events || events.length === 0) return false;
    return events.some((event) => isRecord(event) && typeof event.ph === "string" && event.ph.length === 1);
  },

  parse(input) {
    const events = eventsOf(input.json);
    if (!events) {
      throw new FormatParseError("Expected {traceEvents: [...]} or an array of trace events", "chrome-trace");
    }

    const raw = collectEvents(events);
    if (raw.length === 0) {
      throw new FormatParseError("No complete or begin/end events found", "chrome-trace");
    }

    const spans = rebasePerTrace(
      raw.map((span) => ({
        id: span.id,
        // One file, one trace: the parallel roots are the processes and threads.
        parentId: span.parentId,
        name: span.name,
        startAbsoluteMs: span.startMs,
        durationMs: span.durationMs,
        status: "ok" as const,
        attributes: Object.keys(span.attributes).length > 0 ? span.attributes : undefined,
        service: span.service ?? undefined,
      })),
    );

    return {
      format: "chrome-trace",
      metrics: summarizeTraceMetrics(spans),
      spans,
      label: raw.find((span) => span.parentId === null)?.name,
    };
  },
};
