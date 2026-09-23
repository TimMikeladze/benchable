/**
 * The local report's chart (`.benchable/report.html`). The only module in this package that
 * imports `@tanstack/charts`, which pulls in d3; it is bundled into the report page by
 * `src/cli/local/bundle.ts` and never reaches the library entry points.
 */
import { defineChart, dot, lineY } from "@tanstack/charts";
import { colorLegend } from "@tanstack/charts/legend";
import type { ChartPoint } from "@tanstack/charts/react";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { scaleOrdinal } from "@tanstack/charts/scales/ordinal";
import { tooltip } from "@tanstack/charts/tooltip";

import type { Verdict } from "../comparison";
import { compactNumber, formatPercent, formatValue } from "../format";

const VERDICT_COLOR: Record<Verdict, string> = {
  improved: "var(--viz-good)",
  regressed: "var(--viz-critical)",
  neutral: "var(--viz-neutral)",
};

function verdictColor(verdict: Verdict): string {
  return VERDICT_COLOR[verdict];
}

const dateTime = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** One local run of one metric, for the self-contained `.benchable/report.html`. */
export interface LocalRunPoint {
  /** 1-based position in the local history; runs minutes apart read better by order than by time. */
  index: number;
  stem: string;
  label: string | null;
  startedAt: Date;
  branch: string | null;
  commitSha: string | null;
  value: number;
  verdict: Verdict;
  deltaPct: number | null;
  reason: string | null;
}

const VERDICT_ORDER: Verdict[] = ["improved", "neutral", "regressed"];

/**
 * A metric across the local run history (docs/design.md): a neutral line for the trend,
 * and a dot per run coloured by that run's verdict against its own baseline, with a legend so
 * the verdict is never carried by colour alone.
 */
export function localRunChart(points: readonly LocalRunPoint[], options: { unit?: string | null }) {
  return defineChart({
    marks: [
      lineY(points, {
        x: (d: LocalRunPoint) => d.index,
        y: (d: LocalRunPoint) => d.value,
        stroke: "var(--viz-neutral)",
        strokeWidth: 1.5,
      }),
      dot(points, {
        x: (d: LocalRunPoint) => d.index,
        y: (d: LocalRunPoint) => d.value,
        color: (d: LocalRunPoint) => d.verdict,
        r: 5,
      }),
    ],
    scales: {
      x: {
        scale: scaleLinear,
        axis: { label: "Run", ticks: { format: (v) => (Number.isInteger(v) ? String(v) : "") } },
      },
      y: {
        scale: scaleLinear,
        nice: true,
        grid: true,
        axis: { label: options.unit ?? undefined, ticks: { format: (v) => compactNumber(v as number) } },
      },
    },
    color: {
      scale: scaleOrdinal,
      domain: VERDICT_ORDER,
      range: VERDICT_ORDER.map(verdictColor),
      legend: colorLegend({ label: "Verdict", placement: "bottom" }),
    },
    tooltip: {
      use: tooltip,
      format: (point: ChartPoint<LocalRunPoint>) => {
        const d = point.datum;
        const change = d.deltaPct === null ? "" : ` (${formatPercent(d.deltaPct)})`;
        return [
          `#${d.index} ${d.label ?? d.stem}`,
          dateTime.format(d.startedAt),
          `${formatValue(d.value, options.unit)}${change}`,
          `${d.verdict}${d.reason ? ` — ${d.reason}` : ""}`,
        ].join("\n");
      },
    },
  });
}
