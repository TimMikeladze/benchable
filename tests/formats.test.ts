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
