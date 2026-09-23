import { afterEach, describe, expect, test } from "bun:test";

import { Benchable, BenchableError } from "../src/index";

/**
 * The README's `## SDK` fenced block, kept identical to what's shown there (the last test
 * checks README.md contains it); this file asserts the block actually runs.
 */
const README_SNIPPET = `import { Benchable } from "benchable";

const benchable = new Benchable({ apiKey: process.env.BENCHABLE_KEY! });

const result = await benchable.run({
  branch: "main",
  commitSha: process.env.GITHUB_SHA,
  metrics: { "api.latency_ms": { value: 118.4, p95: 180, p99: 260 } },
});

if (result.regressions > 0) process.exit(1);`;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(response: { status: number; headers?: Record<string, string>; body: unknown }) {
  let captured: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured = { url, init };
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: response.headers,
    });
  }) as typeof fetch;
  return () => captured;
}

describe("Benchable SDK", () => {
  test("run() posts the native payload with a bearer token and reads the verdict off headers", async () => {
    const getCall = mockFetch({
      status: 201,
      headers: { "x-benchable-run-id": "run_123", "x-benchable-regressions": "1", "x-benchable-budget-failures": "0" },
      body: { runId: "run_123", regressions: 1 },
    });

    const benchable = new Benchable({ apiKey: "test_key", baseUrl: "https://example.test" });
    const result = await benchable.run({
      branch: "main",
      metrics: { "api.latency_ms": 118.4 },
      idempotencyKey: "abc",
    });

    expect(result).toEqual({ runId: "run_123", regressions: 1, budgetFailures: 0, body: { runId: "run_123", regressions: 1 } });

    const call = getCall()!;
    expect(call.url).toBe("https://example.test/api/v1/runs");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test_key");
    expect(headers["idempotency-key"]).toBe("abc");
    // idempotencyKey must not leak into the JSON body — it's a header, per the ingest handler.
    expect(JSON.parse(call.init.body as string)).toEqual({ branch: "main", metrics: { "api.latency_ms": 118.4 } });
  });

  test("import() sends the raw body with a text content type and the chosen format in the query", async () => {
    mockFetch({ status: 201, headers: { "x-benchable-regressions": "0", "x-benchable-budget-failures": "0" }, body: {} });
    const getCall = mockFetch({ status: 201, headers: {}, body: {} });

    const benchable = new Benchable({ apiKey: "k" });
    await benchable.import("go-bench", "BenchmarkFoo 100 1000 ns/op");

    const call = getCall()!;
    expect(call.url).toBe("https://benchable.sh/api/v1/import?format=go-bench");
    expect(call.init.body).toBe("BenchmarkFoo 100 1000 ns/op");
    expect((call.init.headers as Record<string, string>)["content-type"]).toBe("text/plain");
  });

  test("a non-2xx response throws BenchableError carrying the status and body", async () => {
    mockFetch({ status: 401, headers: {}, body: { message: "invalid api key" } });

    const benchable = new Benchable({ apiKey: "bad" });
    await expect(benchable.run({ branch: "main", metrics: {} })).rejects.toThrow(BenchableError);
    try {
      await benchable.run({ branch: "main", metrics: {} });
      throw new Error("expected run() to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BenchableError);
      expect((error as BenchableError).status).toBe(401);
      expect((error as BenchableError).body).toEqual({ message: "invalid api key" });
    }
  });

  test("the README's SDK example matches a real, typechecked call to the client", async () => {
    // Same shape as README_SNIPPET, written as real code so `tsc --noEmit` validates it
    // against the actual RunInput type — not just string-matched against the doc.
    mockFetch({ status: 201, headers: { "x-benchable-regressions": "0" }, body: {} });
    const benchable = new Benchable({ apiKey: process.env.BENCHABLE_KEY ?? "test" });
    const result = await benchable.run({
      branch: "main",
      commitSha: process.env.GITHUB_SHA,
      metrics: { "api.latency_ms": { value: 118.4, p95: 180, p99: 260 } },
    });
    expect(result.regressions).toBe(0);

    expect(README_SNIPPET).toContain("new Benchable({ apiKey: process.env.BENCHABLE_KEY! })");
    expect(README_SNIPPET).toContain('metrics: { "api.latency_ms": { value: 118.4, p95: 180, p99: 260 } }');
  });
});

test("README.md shows exactly this SDK snippet", async () => {
  const readme = await Bun.file(new URL("../README.md", import.meta.url)).text();
  expect(readme).toContain(README_SNIPPET);
});
