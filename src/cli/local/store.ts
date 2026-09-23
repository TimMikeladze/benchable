/**
 * Local mode: runs as native JSON files under `.benchable/`, verdicts computed with the same
 * `classify()` the server uses (docs/design.md). Nothing here talks to the network.
 */
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { classify, type Delta } from "../../comparison";
import { inferDirection, inferUnit, runPayloadSchema, withDerivedStats } from "../../schema";
import { parseRaw, type FormatId } from "../../formats";

import { benchableDir } from "../config";

/** The server's default dead band. Local mode has no history-measured band. */
export const LOCAL_THRESHOLD_PCT = 5;

export interface LocalArtifact {
  /** Relative to `.benchable/`. */
  path: string;
  name: string;
  kind?: string;
  bytes: number;
  sha256: string;
}

export interface LocalMetric {
  value: number;
  unit?: string;
  direction?: "lower" | "higher";
  name?: string;
  samples?: number;
  min?: number;
  max?: number;
  mean?: number;
  p50?: number;
  p95?: number;
  p99?: number;
  stddev?: number;
  values?: number[];
  labels?: Record<string, string>;
}

/** Exactly what `POST /api/v1/runs` accepts, plus `artifacts` (which the server ignores). */
export interface LocalRun {
  label?: string;
  branch?: string;
  commitSha?: string;
  environment: string;
  source: string;
  startedAt: string;
  metadata?: Record<string, unknown>;
  metrics: Record<string, LocalMetric>;
  spans?: unknown[];
  idempotencyKey: string;
  artifacts: LocalArtifact[];
}

export interface StoredRun {
  stem: string;
  file: string;
  run: LocalRun;
}

export interface MetricVerdict extends Delta {
  key: string;
  unit: string | null;
  direction: "lower" | "higher";
}

export interface LocalVerdict {
  baseline: string | null;
  metrics: MetricVerdict[];
  regressions: number;
  improvements: number;
}

export function runsDir(root: string) {
  return join(benchableDir(root), "runs");
}

export function artifactsDir(root: string, stem: string) {
  return join(benchableDir(root), "artifacts", stem);
}

export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "run";
}

/** `2026-09-23T10:15:00.123Z` → `20260923T101500Z`. Sorts lexically in time order. */
export function timestampStem(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function listLocalRuns(root: string): StoredRun[] {
  const dir = runsDir(root);
  if (!existsSync(dir)) return [];
  const out: StoredRun[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    try {
      const run = JSON.parse(readFileSync(file, "utf8")) as LocalRun;
      if (!run || typeof run !== "object" || typeof run.metrics !== "object") continue;
      out.push({ stem: name.slice(0, -".json".length), file, run });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => a.run.startedAt.localeCompare(b.run.startedAt) || a.stem.localeCompare(b.stem));
}

function metricDirection(key: string, metric: LocalMetric): "lower" | "higher" {
  return metric.direction ?? inferDirection(key);
}

/**
 * The baseline for a run: an explicit stem, else the latest earlier run on the same branch,
 * else the latest earlier run at all. Mirrors the server's "like for like first" search.
 */
export function pickBaseline(run: LocalRun, earlier: StoredRun[], explicit?: string): StoredRun | null {
  if (explicit) {
    const match = earlier.find((row) => row.stem === explicit || row.run.label === explicit);
    if (!match) throw new Error(`No earlier local run named ${explicit}.`);
    return match;
  }
  const sameBranch = earlier.filter((row) => row.run.branch === run.branch);
  return sameBranch.at(-1) ?? earlier.at(-1) ?? null;
}

export function computeVerdict(run: LocalRun, baseline: StoredRun | null): LocalVerdict {
  const metrics: MetricVerdict[] = Object.entries(run.metrics).map(([key, metric]) => {
    const previous = baseline?.run.metrics[key];
    const direction = metricDirection(key, metric);
    const delta = classify(metric.value, previous ? previous.value : null, direction, LOCAL_THRESHOLD_PCT, {
      current: { stddev: metric.stddev, samples: metric.samples, values: metric.values },
      baseline: previous ? { stddev: previous.stddev, samples: previous.samples, values: previous.values } : null,
    });
    return { key, unit: metric.unit ?? inferUnit(key) ?? null, direction, ...delta };
  });
  return {
    baseline: baseline?.stem ?? null,
    metrics,
    regressions: metrics.filter((m) => m.verdict === "regressed").length,
    improvements: metrics.filter((m) => m.verdict === "improved").length,
  };
}

/** Verdicts for every stored run against its own baseline, oldest first. For the report. */
export function verdictHistory(runs: StoredRun[]): Array<StoredRun & { verdict: LocalVerdict }> {
  return runs.map((row, index) => {
    const earlier = runs.slice(0, index);
    return { ...row, verdict: computeVerdict(row.run, pickBaseline(row.run, earlier)) };
  });
}

export interface RecordOptions {
  root: string;
  /** Any supported tool's output, or a native payload. */
  raw: string;
  format?: FormatId | "auto";
  label?: string;
  branch?: string;
  commitSha?: string;
  environment?: string;
  source?: string;
  artifacts?: Array<{ path: string; kind?: string }>;
  baseline?: string;
  now?: Date;
}

export interface RecordResult {
  stem: string;
  file: string;
  run: LocalRun;
  format: FormatId;
  verdict: LocalVerdict;
}

/**
 * Parse, write `.benchable/runs/<stem>.json` once, copy artifacts beside it, and return the
 * verdict against the baseline. Throws `FormatParseError` for input no adapter recognizes.
 */
export function recordLocal(options: RecordOptions): RecordResult {
  const { run: parsed, adapter } = parseRaw(options.raw, options.format ?? "auto");
  if (Object.keys(parsed.metrics).length === 0 && !parsed.spans?.length) {
    throw new Error(`Parsed as ${adapter.id} but found nothing to record.`);
  }

  const now = options.now ?? new Date();
  const label = options.label ?? parsed.label;
  const earlier = listLocalRuns(options.root);

  const dir = runsDir(options.root);
  mkdirSync(dir, { recursive: true });
  let stem = `${timestampStem(now)}-${slugify(label ?? adapter.id)}`;
  for (let n = 2; existsSync(join(dir, `${stem}.json`)); n += 1) {
    stem = `${timestampStem(now)}-${slugify(label ?? adapter.id)}-${n}`;
  }

  const metrics: Record<string, LocalMetric> = {};
  for (const [key, value] of Object.entries(parsed.metrics)) {
    const { key: _key, ...rest } = withDerivedStats({ key, ...value });
    metrics[key] = rest;
  }

  const artifacts: LocalArtifact[] = [];
  for (const artifact of options.artifacts ?? []) {
    const target = artifactsDir(options.root, stem);
    mkdirSync(target, { recursive: true });
    const name = basename(artifact.path);
    const destination = join(target, name);
    copyFileSync(artifact.path, destination);
    const bytes = readFileSync(destination);
    artifacts.push({
      path: relative(benchableDir(options.root), destination).split("\\").join("/"),
      name,
      ...(artifact.kind ? { kind: artifact.kind } : {}),
      bytes: statSync(destination).size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }

  const run: LocalRun = {
    ...(label ? { label } : {}),
    ...((options.branch ?? parsed.branch) ? { branch: options.branch ?? parsed.branch } : {}),
    ...((options.commitSha ?? parsed.commitSha) ? { commitSha: options.commitSha ?? parsed.commitSha } : {}),
    environment: options.environment ?? parsed.environment ?? "local",
    source: options.source ?? (adapter.id === "benchable" ? "benchable-local" : adapter.id),
    startedAt: (parsed.startedAt ?? now).toISOString(),
    ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
    metrics,
    ...(parsed.spans?.length ? { spans: parsed.spans } : {}),
    // Fixed now and never rewritten: the same key reaches the server whether the file is
    // synced by the CLI or picked up by local watch, so either path yields one run.
    idempotencyKey: parsed.idempotencyKey ?? `local:${stem}-${randomBytes(4).toString("hex")}`,
    artifacts,
  };

  // The file must be something the server accepts verbatim; refuse to write one it wouldn't.
  const check = runPayloadSchema.safeParse(run);
  if (!check.success) throw new Error(`Refusing to write an invalid run: ${check.error.issues[0]?.message}`);

  // Before writing, so a bad `--baseline` leaves nothing behind.
  const baseline = pickBaseline(run, earlier, options.baseline);
  const file = join(dir, `${stem}.json`);
  writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`);

  const verdict = computeVerdict(run, baseline);
  return { stem, file, run, format: adapter.id, verdict };
}
