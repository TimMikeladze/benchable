import { describe, expect, test } from "bun:test";

import {
  humanizeMetricKey,
  inferDirection,
  inferUnit,
  normalizeMetrics,
  runPayloadSchema,
} from "../src/schema";

describe("runPayloadSchema", () => {
  test("accepts a bare number as a whole metric", () => {
    const parsed = runPayloadSchema.parse({ metrics: { "build.time_ms": 4210 } });
    expect(parsed.metrics["build.time_ms"]).toBe(4210);
  });

  test("accepts the full statistical form", () => {
    const parsed = runPayloadSchema.parse({
      branch: "main",
      metrics: {
        "api.latency_ms": { value: 118.4, p95: 180, samples: 500, labels: { route: "/checkout" } },
      },
      spans: [{ id: "root", name: "request", startMs: 0, durationMs: 118.4 }],
    });
    expect(parsed.spans).toHaveLength(1);
    expect(parsed.metrics["api.latency_ms"]).toMatchObject({ value: 118.4, p95: 180 });
  });

  test("rejects non-finite values rather than storing NaN", () => {
    expect(runPayloadSchema.safeParse({ metrics: { a: Number.POSITIVE_INFINITY } }).success).toBe(
      false,
    );
    expect(runPayloadSchema.safeParse({ metrics: { a: "fast" } }).success).toBe(false);
  });

  test("requires a metrics object", () => {
    expect(runPayloadSchema.safeParse({ branch: "main" }).success).toBe(false);
  });

  test("coerces an ISO startedAt to a Date", () => {
    const parsed = runPayloadSchema.parse({
      startedAt: "2026-09-14T10:00:00.000Z",
      metrics: { a: 1 },
    });
    expect(parsed.startedAt?.toISOString()).toBe("2026-09-14T10:00:00.000Z");
  });
});

describe("normalizeMetrics", () => {
  test("flattens both shorthand and full form to one record type", () => {
    const rows = normalizeMetrics({ "a.ms": 12, "b.ms": { value: 5, unit: "s" } });
    expect(rows).toEqual([
      { key: "a.ms", value: 12 },
      { key: "b.ms", value: 5, unit: "s" },
    ]);
  });
});

describe("inference from the metric key", () => {
  test("reads a unit off the suffix", () => {
    expect(inferUnit("api.latency_ms")).toBe("ms");
    expect(inferUnit("bundle.main_kb")).toBe("KB");
    expect(inferUnit("cache.hit_rate")).toBeUndefined();
  });

  test("assumes lower is better unless the name says otherwise", () => {
    expect(inferDirection("api.latency_ms")).toBe("lower");
    expect(inferDirection("search.throughput_ops")).toBe("higher");
    expect(inferDirection("cache.hit_rate")).toBe("higher");
  });

  test("turns a key into a readable name and drops the unit suffix", () => {
    expect(humanizeMetricKey("api.p95_latency_ms")).toBe("Api P95 Latency");
    expect(humanizeMetricKey("build.time_ms")).toBe("Build Time");
    expect(humanizeMetricKey("score")).toBe("Score");
  });
});
