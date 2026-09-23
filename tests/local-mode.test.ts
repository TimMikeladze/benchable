/** The local-mode writer, verdicts and report.html (docs/agent-skill.md). */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderReport } from "../src/cli/local/report";
import { buildReportData } from "../src/cli/local/report-data";
import { listLocalRuns, recordLocal, verdictHistory } from "../src/cli/local/store";
import { runPayloadSchema } from "../src/schema";
import { parseRaw } from "../src/formats";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "benchable-local-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A hyperfine export for one named command with the given timings, in seconds. */
function hyperfine(times: number[], name = "work") {
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const sd = Math.sqrt(times.reduce((a, t) => a + (t - mean) ** 2, 0) / (times.length - 1));
  return JSON.stringify({
    results: [{ command: name, mean, stddev: sd, median: mean, min: Math.min(...times), max: Math.max(...times), times }],
  });
}

const jitter = (base: number, n = 20) => Array.from({ length: n }, (_, i) => base * (1 + ((i % 5) - 2) * 0.01));

describe("recordLocal", () => {
  test("writes a native payload the server accepts, with a fixed idempotency key", () => {
    const result = recordLocal({ root, raw: hyperfine(jitter(0.01)), label: "baseline", branch: "main", now: new Date("2026-09-23T10:00:00Z") });
    expect(result.stem).toBe("20260923T100000Z-baseline");
    expect(result.format).toBe("hyperfine");

    const onDisk = JSON.parse(readFileSync(result.file, "utf8"));
    expect(runPayloadSchema.safeParse(onDisk).success).toBe(true);
    expect(onDisk.idempotencyKey).toMatch(/^local:20260923T100000Z-baseline-[0-9a-f]{8}$/);
    expect(onDisk.environment).toBe("local");
    // hyperfine's raw samples survive, so a later comparison can use Mann–Whitney.
    expect(onDisk.metrics["hyperfine.work.mean_ms"].values).toHaveLength(20);

    // Local watch and the import route read the file's own key and branch.
    const reparsed = parseRaw(readFileSync(result.file, "utf8"));
    expect(reparsed.adapter.id).toBe("benchable");
    expect(reparsed.run).toMatchObject({ idempotencyKey: onDisk.idempotencyKey, branch: "main", environment: "local" });
  });

  test("before/after: a real slowdown regresses with Mann–Whitney, noise stays neutral", () => {
    recordLocal({ root, raw: hyperfine(jitter(0.01)), label: "before", branch: "main", now: new Date("2026-09-23T10:00:00Z") });
    const same = recordLocal({ root, raw: hyperfine(jitter(0.0101)), label: "noise", branch: "main", now: new Date("2026-09-23T10:01:00Z") });
    expect(same.verdict.baseline).toBe("20260923T100000Z-before");
    expect(same.verdict.regressions).toBe(0);

    const slow = recordLocal({ root, raw: hyperfine(jitter(0.02)), label: "after", branch: "main", now: new Date("2026-09-23T10:02:00Z") });
    const mean = slow.verdict.metrics.find((m) => m.key === "hyperfine.work.mean_ms")!;
    expect(mean.verdict).toBe("regressed");
    expect(mean.significance?.test).toBe("mann-whitney");
    expect(mean.significance?.significant).toBe(true);
    expect(slow.verdict.baseline).toBe("20260923T100100Z-noise");
  });

  test("baseline prefers the same branch, and --baseline overrides it", () => {
    recordLocal({ root, raw: hyperfine(jitter(0.01)), label: "main", branch: "main", now: new Date("2026-09-23T10:00:00Z") });
    recordLocal({ root, raw: hyperfine(jitter(0.01)), label: "other", branch: "feature", now: new Date("2026-09-23T10:01:00Z") });
    const next = recordLocal({ root, raw: hyperfine(jitter(0.01)), branch: "main", now: new Date("2026-09-23T10:02:00Z") });
    expect(next.verdict.baseline).toBe("20260923T100000Z-main");
    const pinned = recordLocal({ root, raw: hyperfine(jitter(0.01)), branch: "main", baseline: "other", now: new Date("2026-09-23T10:03:00Z") });
    expect(pinned.verdict.baseline).toBe("20260923T100100Z-other");
    expect(() => recordLocal({ root, raw: hyperfine(jitter(0.01)), baseline: "nope" })).toThrow("No earlier local run");
    expect(listLocalRuns(root)).toHaveLength(4);
  });

  test("copies artifacts outside runs/ with a checksum", () => {
    const svg = join(root, "flame.svg");
    writeFileSync(svg, "<svg/>");
    const result = recordLocal({ root, raw: hyperfine(jitter(0.01)), artifacts: [{ path: svg, kind: "flamegraph" }], now: new Date("2026-09-23T10:00:00Z") });
    expect(result.run.artifacts[0]).toMatchObject({ name: "flame.svg", kind: "flamegraph", bytes: 6, path: "artifacts/20260923T100000Z-hyperfine/flame.svg" });
    expect(existsSync(join(root, ".benchable", "artifacts", "20260923T100000Z-hyperfine", "flame.svg"))).toBe(true);
  });

  test("refuses input no adapter recognizes, writing nothing", () => {
    expect(() => recordLocal({ root, raw: "hello, not a benchmark\x00" })).toThrow();
    expect(listLocalRuns(root)).toHaveLength(0);
  });
});

describe("report.html", () => {
  test("embeds data safely and renders verdicts without JavaScript", () => {
    recordLocal({ root, raw: hyperfine(jitter(0.01)), label: "before", now: new Date("2026-09-23T10:00:00Z") });
    recordLocal({ root, raw: hyperfine(jitter(0.02)), label: "</script><b>after", now: new Date("2026-09-23T10:01:00Z") });
    const data = buildReportData("demo", verdictHistory(listLocalRuns(root)), { now: new Date("2026-09-23T11:00:00Z") });
    expect(data.metrics.find((m) => m.key === "hyperfine.work.mean_ms")?.points.map((p) => p.verdict)).toEqual(["neutral", "regressed"]);

    const html = renderReport(data, "window.__bundle = '</script>';");
    // One closing tag per script element: neither the label nor the bundle can end one early.
    expect(html.match(/<\/script>/g)).toHaveLength(3);
    expect(html).toContain("&lt;/script&gt;&lt;b&gt;after");
    expect(html).toContain("1 metric regressed against 20260923T100000Z-before");
    expect(html).toContain('data-chart="0"');
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).not.toMatch(/<(link|script)[^>]+(src|href)=["']https?:/);
  });
});
