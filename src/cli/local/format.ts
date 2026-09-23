import { formatPercent, formatValue } from "../../format";

import type { LocalVerdict } from "./store";

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length)));
  const line = (row: string[]) =>
    row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join("  ").trimEnd();
  return [line(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

const MARK = { improved: "▼", regressed: "▲", neutral: "·" } as const;

/** The same shape as the server's digest, so an agent reads both modes the same way. */
export function formatLocalVerdict(verdict: LocalVerdict): string {
  const rows = verdict.metrics.map((m) => {
    const sig = m.significance
      ? `${m.significance.test === "mann-whitney" ? "mann-whitney" : "welch"} ${
          m.significance.p < 0.001 ? "p<0.001" : `p=${m.significance.p.toFixed(3)}`
        }${m.significance.significant ? "" : " ns"}`
      : "—";
    return [
      m.key,
      formatValue(m.value, m.unit),
      m.baseline === null ? "—" : formatValue(m.baseline, m.unit),
      m.baseline === null ? "first run" : `${MARK[m.verdict]} ${formatPercent(m.deltaPct)}`,
      m.verdict,
      sig,
    ];
  });
  const summary =
    verdict.baseline === null
      ? "First run: nothing to compare against yet."
      : verdict.metrics.every((m) => m.baseline === null)
        ? "No metric in common with the baseline. Keep metric names stable across runs (hyperfine -n <name>)."
        : verdict.regressions > 0
        ? `${verdict.regressions} metric${verdict.regressions === 1 ? "" : "s"} regressed.`
        : verdict.improvements > 0
          ? `${verdict.improvements} improved, no regressions.`
          : "No regressions.";
  return [
    `baseline: ${verdict.baseline ?? "none"}`,
    "",
    table(["metric", "value", "baseline", "change", "verdict", "test"], rows),
    "",
    summary,
  ].join("\n");
}
