import type { Verdict } from "../../comparison";
import { humanizeMetricKey } from "../../schema";

import type { LocalArtifact, LocalVerdict, StoredRun } from "./store";

/** What report.html embeds as JSON. Dates are ISO strings; the client revives them. */
export interface ReportData {
  title: string;
  generatedAt: string;
  runs: Array<{
    stem: string;
    label: string | null;
    startedAt: string;
    branch: string | null;
    commitSha: string | null;
    environment: string;
    source: string;
    artifacts: LocalArtifact[];
    verdict: LocalVerdict;
    cloudUrl: string | null;
  }>;
  metrics: Array<{
    key: string;
    name: string;
    unit: string | null;
    direction: "lower" | "higher";
    points: Array<{
      index: number;
      stem: string;
      label: string | null;
      startedAt: string;
      branch: string | null;
      commitSha: string | null;
      value: number;
      verdict: Verdict;
      deltaPct: number | null;
      reason: string | null;
    }>;
  }>;
}

export function buildReportData(
  title: string,
  history: Array<StoredRun & { verdict: LocalVerdict }>,
  options: { now?: Date; cloudUrls?: Record<string, string> } = {},
): ReportData {
  const metrics = new Map<string, ReportData["metrics"][number]>();
  history.forEach((row, index) => {
    for (const entry of row.verdict.metrics) {
      let metric = metrics.get(entry.key);
      if (!metric) {
        metric = {
          key: entry.key,
          name: row.run.metrics[entry.key]?.name ?? humanizeMetricKey(entry.key),
          unit: entry.unit,
          direction: entry.direction,
          points: [],
        };
        metrics.set(entry.key, metric);
      }
      metric.points.push({
        index: index + 1,
        stem: row.stem,
        label: row.run.label ?? null,
        startedAt: row.run.startedAt,
        branch: row.run.branch ?? null,
        commitSha: row.run.commitSha ?? null,
        value: entry.value,
        verdict: entry.verdict,
        deltaPct: entry.deltaPct,
        reason: entry.reason ?? null,
      });
    }
  });

  return {
    title,
    generatedAt: (options.now ?? new Date()).toISOString(),
    runs: history.map((row) => ({
      stem: row.stem,
      label: row.run.label ?? null,
      startedAt: row.run.startedAt,
      branch: row.run.branch ?? null,
      commitSha: row.run.commitSha ?? null,
      environment: row.run.environment,
      source: row.run.source,
      artifacts: row.run.artifacts ?? [],
      verdict: row.verdict,
      cloudUrl: options.cloudUrls?.[row.run.idempotencyKey] ?? null,
    })),
    metrics: [...metrics.values()],
  };
}
