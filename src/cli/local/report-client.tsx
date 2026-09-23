/**
 * Browser entry for `.benchable/report.html`. Bundled with React and TanStack Charts and
 * inlined into the page, so the report makes no network requests. Chart definitions come from
 * `lib/charts/chart-definitions.ts`, the one module that imports the chart library.
 */
import { createRoot } from "react-dom/client";

import { Chart } from "@tanstack/charts/react";

import { localRunChart, type LocalRunPoint } from "../../report/chart";

import type { ReportData } from "./report-data";

function boot() {
  const source = document.getElementById("benchable-data");
  if (!source?.textContent) return;
  const data = JSON.parse(source.textContent) as ReportData;

  for (const [index, metric] of data.metrics.entries()) {
    const mount = document.querySelector<HTMLElement>(`[data-chart="${index}"]`);
    if (!mount) continue;
    const points: LocalRunPoint[] = metric.points.map((point) => ({ ...point, startedAt: new Date(point.startedAt) }));
    mount.textContent = "";
    createRoot(mount).render(
      <Chart
        definition={localRunChart(points, { unit: metric.unit })}
        height={240}
        ariaLabel={`${metric.name} across ${points.length} local run${points.length === 1 ? "" : "s"}, coloured by verdict`}
      />,
    );
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
