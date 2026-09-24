import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ADAPTERS,
  detectFormat,
  parseRaw,
  toFormatInput,
  FormatParseError,
  type FormatId,
} from "../src/formats";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

function parse(name: string) {
  return parseRaw(fixture(name));
}

describe("format detection", () => {
  const cases: Array<[string, FormatId]> = [
    ["go-bench.txt", "go-bench"],
    ["hyperfine.json", "hyperfine"],
    ["pytest-benchmark.json", "pytest-benchmark"],
    ["google-benchmark.json", "google-benchmark"],
    ["criterion.ndjson", "criterion"],
    ["vitest-bench.json", "vitest-bench"],
    ["k6.json", "k6"],
    ["lighthouse.json", "lighthouse"],
    ["jmh.json", "jmh"],
    ["prometheus.txt", "prometheus"],
    ["bench.csv", "csv"],
    ["otlp-trace.json", "otlp-trace"],
    ["jaeger.json", "jaeger"],
    ["zipkin.json", "zipkin"],
    ["chrome-trace.json", "chrome-trace"],
  ];

  for (const [file, expected] of cases) {
    test(`${file} is detected as ${expected}`, () => {
      expect(detectFormat(toFormatInput(fixture(file)))?.id).toBe(expected);
    });
  }

  test("the native payload wins over everything else", () => {
    const input = toFormatInput(JSON.stringify({ metrics: { "build.time_ms": 4210 } }));
    expect(detectFormat(input)?.id).toBe("benchable");
  });

  test("unrecognized input is reported, not guessed at", () => {
    expect(() => parseRaw("this is just prose, not a benchmark")).toThrow(FormatParseError);
  });

  test("no adapter throws on hostile input", () => {
    const hostile = ["", "{", "null", "[]", "{}", '{"metrics":null}', String.fromCharCode(0, 1)];
    for (const raw of hostile) {
      const input = toFormatInput(raw);
      for (const adapter of ADAPTERS) {
        expect(() => adapter.detect(input)).not.toThrow();
      }
    }
  });

  test("an explicit format reports a parse error instead of falling through", () => {
    expect(() => parseRaw(fixture("bench.csv"), "hyperfine")).toThrow(FormatParseError);
  });
});

describe("go-bench", () => {
  const { run } = parse("go-bench.txt");

  test("one metric per measurement column", () => {
    expect(run.metrics["go.BenchmarkEncode.ns_per_op"]).toMatchObject({
      value: 1053,
      unit: "ns",
      direction: "lower",
      samples: 1183424,
    });
    expect(run.metrics["go.BenchmarkEncode.B_per_op"]?.value).toBe(512);
    expect(run.metrics["go.BenchmarkEncode.allocs_per_op"]?.value).toBe(4);
  });

  test("throughput counts as higher-is-better", () => {
    expect(run.metrics["go.BenchmarkStream.MB_per_s"]).toMatchObject({
      value: 452.11,
      direction: "higher",
    });
  });

  test("GOMAXPROCS becomes a label, not part of the key", () => {
    expect(run.metrics["go.BenchmarkEncode.ns_per_op"]?.labels).toEqual({ procs: "10" });
    expect(Object.keys(run.metrics).some((key) => key.includes("-10"))).toBe(false);
  });

  test("the environment header lands in metadata", () => {
    expect(run.metadata).toMatchObject({ goos: "darwin", goarch: "arm64", cpu: "Apple M1 Pro" });
  });
});

describe("hyperfine", () => {
  const { run } = parse("hyperfine.json");

  test("seconds are converted to milliseconds", () => {
    expect(run.metrics["hyperfine.build.sh.mean_ms"]).toMatchObject({
      value: 1234.5,
      unit: "ms",
      direction: "lower",
      min: 1150.2,
      max: 1340.1,
      p50: 1220.1,
      samples: 5,
    });
  });
});

describe("pytest-benchmark", () => {
  const { run } = parse("pytest-benchmark.json");

  test("stats convert to milliseconds and keep the round count", () => {
    expect(run.metrics["pytest.test_dumps.mean_ms"]).toMatchObject({
      value: 0.145,
      unit: "ms",
      samples: 4821,
      labels: { group: "serialize" },
    });
  });

  test("ops/s is higher-is-better", () => {
    expect(run.metrics["pytest.test_dumps.ops"]).toMatchObject({
      value: 6896.55,
      direction: "higher",
    });
  });

  test("the commit is carried through", () => {
    expect(run.metadata).toMatchObject({ commit: "9f3c1abcd" });
  });
});

describe("google-benchmark", () => {
  const { run } = parse("google-benchmark.json");

  test("aggregates fold into one metric rather than becoming three", () => {
    const metric = run.metrics["gbench.BM_Encode.real_time_ms"];
    expect(metric?.value).toBeCloseTo(0.0010532, 7);
    expect(metric?.samples).toBe(664108);
    expect(metric?.p50).toBeCloseTo(0.001058, 6);
    expect(metric?.stddev).toBeCloseTo(0.0000127, 7);
    expect(Object.keys(run.metrics).some((key) => key.includes("_mean"))).toBe(false);
  });

  test("throughput counters come through", () => {
    expect(run.metrics["gbench.BM_Encode.bytes_per_second"]).toMatchObject({
      value: 486000000,
      direction: "higher",
    });
  });
});

describe("criterion", () => {
  const { run } = parse("criterion.ndjson");

  test("only benchmark-complete messages are used", () => {
    expect(Object.keys(run.metrics)).toEqual(["criterion.fib_20.ms"]);
  });

  test("nanoseconds convert to milliseconds", () => {
    expect(run.metrics["criterion.fib_20.ms"]).toMatchObject({ value: 0.021, unit: "ms" });
  });
});

describe("vitest-bench", () => {
  const { run } = parse("vitest-bench.json");

  test("mean time and hz both land, pointing opposite ways", () => {
    expect(run.metrics["vitest.JSON.stringify.mean_ms"]).toMatchObject({
      value: 0.00096,
      direction: "lower",
      samples: 53211,
    });
    expect(run.metrics["vitest.JSON.stringify.hz"]).toMatchObject({
      value: 1043210.5,
      direction: "higher",
    });
  });

  test("the file and group survive as labels", () => {
    expect(run.metrics["vitest.JSON.stringify.mean_ms"]?.labels).toMatchObject({
      file: "/repo/bench/json.bench.ts",
    });
  });
});

describe("k6", () => {
  const { run } = parse("k6.json");

  test("trend metrics keep their percentiles", () => {
    expect(run.metrics["k6.http_req_duration.avg"]).toMatchObject({
      value: 118.42,
      unit: "ms",
      direction: "lower",
      p50: 110.3,
      p95: 180.4,
      p99: 260.1,
    });
  });

  test("counters and gauges use the right field", () => {
    expect(run.metrics["k6.http_reqs.count"]?.value).toBe(14820);
    expect(run.metrics["k6.http_reqs.rate"]?.value).toBe(246.9);
    expect(run.metrics["k6.vus_max.value"]?.value).toBe(50);
  });

  test("failure metrics are lower-is-better", () => {
    expect(run.metrics["k6.http_req_failed.value"]?.direction).toBe("lower");
  });
});

describe("lighthouse", () => {
  const { run } = parse("lighthouse.json");

  test("category scores become percentages and are higher-is-better", () => {
    expect(run.metrics["lighthouse.performance.score"]).toMatchObject({
      value: 94,
      unit: "%",
      direction: "higher",
    });
  });

  test("numeric audits carry their unit and direction", () => {
    expect(run.metrics["lighthouse.largest-contentful-paint.ms"]).toMatchObject({
      value: 2410.2,
      unit: "ms",
      direction: "lower",
    });
  });

  test("audits without a numeric value are skipped", () => {
    expect(Object.keys(run.metrics).some((key) => key.includes("is-on-https"))).toBe(false);
  });
});

describe("jmh", () => {
  const { run } = parse("jmh.json");

  test("percentiles and score error come through", () => {
    expect(run.metrics["jmh.com.example.EncodeBench.encode.ns_per_op"]).toMatchObject({
      value: 1053.21,
      unit: "ns/op",
      direction: "lower",
      stddev: 24.7,
      p95: 1120,
      p99: 1180,
      labels: { mode: "avgt" },
    });
  });
});

describe("prometheus", () => {
  const { run } = parse("prometheus.txt");

  test("quantiles fold into one metric's percentiles", () => {
    const metric = run.metrics["prom.http_request_duration_seconds.handler_/checkout"];
    expect(metric).toBeDefined();
    expect(metric).toMatchObject({ p50: 0.0503, p95: 0.1204, p99: 0.2601 });
  });

  test("plain counters come through", () => {
    expect(run.metrics["prom.process_cpu_seconds_total"]?.value).toBe(4.21);
  });

  test("histogram buckets are skipped — a cumulative count is not a benchmark value", () => {
    expect(Object.keys(run.metrics).some((key) => key.includes("bucket"))).toBe(false);
  });
});

describe("csv", () => {
  const { run } = parse("bench.csv");

  test("the header row is recognized and skipped", () => {
    expect(Object.keys(run.metrics).sort()).toEqual([
      "api.rps",
      "build.time_ms",
      "bundle.main_kb",
    ]);
  });

  test("an explicit direction is honoured", () => {
    expect(run.metrics["api.rps"]).toMatchObject({ value: 1840.5, direction: "higher" });
    expect(run.metrics["bundle.main_kb"]?.direction).toBeUndefined();
  });

  test("a headerless file parses too", () => {
    const { run: headerless } = parseRaw("a.b,1\nc.d,2");
    expect(headerless.metrics["a.b"]?.value).toBe(1);
    expect(headerless.metrics["c.d"]?.value).toBe(2);
  });
});

describe("otlp-trace", () => {
  const { run } = parse("otlp-trace.json");

  test("spans are rebased so the earliest start is zero", () => {
    expect(run.spans).toHaveLength(3);
    const root = run.spans?.find((span) => span.id === "root");
    expect(root).toMatchObject({ startMs: 0, durationMs: 210, parentId: null });
  });

  test("nesting and error status survive", () => {
    const scan = run.spans?.find((span) => span.id === "scan");
    expect(scan).toMatchObject({ parentId: "db", startMs: 25, durationMs: 90, status: "error" });
  });

  test("summary metrics are derived from the trace", () => {
    expect(run.metrics["trace.total_ms"]?.value).toBe(210);
    expect(run.metrics["trace.span_count"]?.value).toBe(3);
    expect(run.metrics["trace.error_spans"]?.value).toBe(1);
  });

  test("attributes are flattened from the OTLP value wrappers", () => {
    const db = run.spans?.find((span) => span.id === "db");
    expect(db?.attributes).toMatchObject({ "db.rows": 128 });
  });

  test("the service name comes from the resource", () => {
    expect(run.spans?.every((span) => span.service === "checkout")).toBe(true);
  });
});

describe("jaeger", () => {
  const { run } = parse("jaeger.json");

  test("carries trace ids, so two traces stay separate", () => {
    expect(run.spans).toHaveLength(3);
    const ids = new Set(run.spans?.map((span) => span.traceId));
    expect([...ids].sort()).toEqual(["trace-a", "trace-b"]);
  });

  test("each trace is rebased to its own zero", () => {
    const req1 = run.spans?.find((span) => span.id === "req1");
    const req2 = run.spans?.find((span) => span.id === "req2");
    expect(req1).toMatchObject({ startMs: 0, durationMs: 240 });
    expect(req2).toMatchObject({ startMs: 0, durationMs: 90 });
  });

  test("the parent comes from a CHILD_OF reference", () => {
    expect(run.spans?.find((span) => span.id === "query1")?.parentId).toBe("req1");
  });

  test("process gives the service and its tags become attributes", () => {
    const query = run.spans?.find((span) => span.id === "query1");
    expect(query?.service).toBe("postgres");
    expect(query?.attributes).toMatchObject({ "db.rows": 128 });
    const request = run.spans?.find((span) => span.id === "req1");
    expect(request?.service).toBe("api");
    expect(request?.attributes).toMatchObject({ "host.name": "api-1", "http.method": "GET" });
  });

  test("an error tag marks the span", () => {
    expect(run.spans?.find((span) => span.id === "query1")?.status).toBe("error");
    expect(run.spans?.find((span) => span.id === "req1")?.status).toBe("ok");
  });

  test("summary metrics include the trace count", () => {
    expect(run.metrics["trace.trace_count"]?.value).toBe(2);
    expect(run.metrics["trace.span_count"]?.value).toBe(3);
    expect(run.metrics["trace.error_spans"]?.value).toBe(1);
  });
});

describe("zipkin", () => {
  const { run } = parse("zipkin.json");

  test("microsecond timings convert and rebase per trace", () => {
    expect(run.spans).toHaveLength(3);
    const root = run.spans?.find((span) => span.id === "root1");
    expect(root).toMatchObject({ startMs: 0, durationMs: 310, parentId: null });
  });

  test("a shared (server-half) duplicate id is folded away", () => {
    expect(run.spans?.filter((span) => span.id === "db1")).toHaveLength(1);
    expect(run.spans?.find((span) => span.id === "db1")?.service).toBe("storefront");
  });

  test("tags become attributes and the remote endpoint is kept", () => {
    const db = run.spans?.find((span) => span.id === "db1");
    expect(db?.attributes).toMatchObject({ "sql.query": "select * from orders", "peer.service": "postgres" });
  });

  test("a string error tag marks the span", () => {
    expect(run.spans?.find((span) => span.id === "cache1")?.status).toBe("error");
    expect(run.spans?.find((span) => span.id === "root1")?.status).toBe("ok");
  });

  test("timestamp microseconds become the run's startedAt", () => {
    expect(run.startedAt?.toISOString()).toBe(new Date(1789450000000).toISOString());
  });
});

describe("chrome-trace", () => {
  const { run } = parse("chrome-trace.json");

  test("X events and matched B/E pairs become spans; other phases are skipped", () => {
    const names = run.spans?.map((span) => span.name).sort();
    expect(names).toEqual(["DrawFrame", "Layout", "Navigate", "ParseHTML", "UpdateLayoutTree"]);
  });

  test("nesting follows the per-thread stack", () => {
    const spans = run.spans!;
    const navigate = spans.find((span) => span.name === "Navigate");
    const layout = spans.find((span) => span.name === "Layout");
    const update = spans.find((span) => span.name === "UpdateLayoutTree");
    expect(layout?.parentId).toBe(navigate?.id);
    expect(update?.parentId).toBe(layout?.id);
    // A different thread is a parallel root, not a child.
    expect(spans.find((span) => span.name === "DrawFrame")?.parentId).toBeNull();
  });

  test("B/E duration is the pair's span", () => {
    expect(run.spans?.find((span) => span.name === "Navigate")).toMatchObject({
      startMs: 0,
      durationMs: 6,
    });
    expect(run.spans?.find((span) => span.name === "Layout")).toMatchObject({ startMs: 3.5, durationMs: 1.7 });
  });

  test("metadata events give the service and thread name", () => {
    const parse = run.spans?.find((span) => span.name === "ParseHTML");
    expect(parse?.service).toBe("Renderer");
    expect(parse?.attributes).toMatchObject({ "thread.name": "CrRendererMain", length: 4200 });
  });

  test("the whole file is one trace with no trace ids", () => {
    expect(run.spans?.every((span) => span.traceId === undefined)).toBe(true);
    expect(run.metrics["trace.trace_count"]).toBeUndefined();
  });
});

describe("every adapter", () => {
  test("declares how to produce its input", () => {
    for (const adapter of ADAPTERS) {
      expect(adapter.produce.length).toBeGreaterThan(0);
      expect(adapter.description.length).toBeGreaterThan(0);
    }
  });

  test("produces keys that are safe in a URL path segment", () => {
    for (const file of ["go-bench.txt", "hyperfine.json", "prometheus.txt", "jmh.json"]) {
      const { run } = parse(file);
      for (const key of Object.keys(run.metrics)) {
        expect(key).toMatch(/^[A-Za-z0-9._/-]+$/);
        expect(key.length).toBeLessThanOrEqual(200);
      }
    }
  });
});

describe("go-bench -count", () => {
  test("repetitions become a sample vector", () => {
    const raw = [
      "BenchmarkParse-8   1000   1200 ns/op   64 B/op   2 allocs/op",
      "BenchmarkParse-8   1000   1300 ns/op   64 B/op   2 allocs/op",
      "BenchmarkParse-8   1000   1100 ns/op   64 B/op   2 allocs/op",
    ].join("\n");
    const metric = parseRaw(raw).run.metrics["go.BenchmarkParse.ns_per_op"];
    expect(metric).toMatchObject({ value: 1200, mean: 1200, samples: 3, values: [1200, 1300, 1100] });
  });
});
