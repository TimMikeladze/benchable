/**
 * `.benchable/report.html`: one self-contained file with no network requests. Tables and
 * verdicts are rendered here as plain HTML, so the report reads without JavaScript; the
 * inlined bundle (report-client.tsx) draws the charts. See docs/design.md.
 */
import { formatPercent, formatValue } from "../../format";

import type { ReportData } from "./report-data";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** JSON inside a `<script>`: `<` escaped so no value can close the tag early. */
function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(new RegExp("\u2028", "g"), "\\u2028")
    .replace(new RegExp("\u2029", "g"), "\\u2029");
}

/** A bundle inlined into `<script>` must not contain a literal closing tag. */
function embedScript(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}

const dateTime = (iso: string) =>
  new Date(iso).toISOString().replace("T", " ").replace(/:\d{2}\.\d{3}Z$/, " UTC");

function verdictPill(verdict: string) {
  return `<span class="pill pill--${escapeHtml(verdict)}">${escapeHtml(verdict)}</span>`;
}

function significanceCell(entry: ReportData["runs"][number]["verdict"]["metrics"][number]): string {
  const s = entry.significance;
  if (!s) return "—";
  const p = s.p < 0.001 ? "p&lt;0.001" : `p=${s.p.toFixed(3)}`;
  const test = s.test === "mann-whitney" ? "Mann–Whitney" : "Welch t";
  return `${test}, ${p}${s.significant ? "" : " (ns)"}`;
}

function latestSection(data: ReportData): string {
  const latest = data.runs.at(-1);
  if (!latest) {
    return `<section><h2>No runs yet</h2><p class="muted">Record one with <code>benchable record --file &lt;output&gt;</code>.</p></section>`;
  }
  const { verdict } = latest;
  const headline =
    verdict.baseline === null
      ? "First run — nothing to compare against yet."
      : verdict.metrics.every((m) => m.baseline === null)
        ? `No metric in common with ${escapeHtml(verdict.baseline)}.`
        : verdict.regressions > 0
        ? `${verdict.regressions} metric${verdict.regressions === 1 ? "" : "s"} regressed against ${escapeHtml(verdict.baseline)}.`
        : verdict.improvements > 0
          ? `${verdict.improvements} improved, none regressed, against ${escapeHtml(verdict.baseline)}.`
          : `Unchanged against ${escapeHtml(verdict.baseline)}.`;

  const rows = verdict.metrics
    .map(
      (m) => `<tr>
  <th scope="row"><code>${escapeHtml(m.key)}</code></th>
  <td class="num">${escapeHtml(formatValue(m.value, m.unit))}</td>
  <td class="num">${m.baseline === null ? "—" : escapeHtml(formatValue(m.baseline, m.unit))}</td>
  <td class="num">${m.deltaPct === null ? "—" : escapeHtml(formatPercent(m.deltaPct))}</td>
  <td>${verdictPill(m.verdict)}</td>
  <td class="muted">${significanceCell(m)}</td>
  <td class="muted">${escapeHtml(m.reason ?? "")}</td>
</tr>`,
    )
    .join("\n");

  return `<section>
  <p class="eyebrow">Latest run</p>
  <h2>${escapeHtml(latest.label ?? latest.stem)}</h2>
  <p class="lede ${verdict.regressions > 0 ? "lede--bad" : ""}">${headline}</p>
  <div class="scroll"><table>
    <thead><tr><th>Metric</th><th class="num">Value</th><th class="num">Baseline</th><th class="num">Change</th><th>Verdict</th><th>Test</th><th>Why</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
</section>`;
}

function metricSections(data: ReportData): string {
  if (data.metrics.length === 0) return "";
  const cards = data.metrics
    .map((metric, index) => {
      const last = metric.points.at(-1);
      return `<figure class="card">
  <figcaption><strong>${escapeHtml(metric.name)}</strong> <code>${escapeHtml(metric.key)}</code>
    <span class="muted">${metric.direction === "lower" ? "lower is better" : "higher is better"}</span></figcaption>
  <div class="chart" data-chart="${index}">
    <p class="muted">${metric.points.length} run${metric.points.length === 1 ? "" : "s"}; latest ${
      last ? escapeHtml(formatValue(last.value, metric.unit)) : "—"
    }. Charts need JavaScript.</p>
  </div>
</figure>`;
    })
    .join("\n");
  return `<section><p class="eyebrow">History</p><h2>Metrics across local runs</h2><div class="cards">${cards}</div></section>`;
}

function runsSection(data: ReportData): string {
  if (data.runs.length === 0) return "";
  const rows = [...data.runs]
    .reverse()
    .map((run) => {
      const artifacts = run.artifacts.length
        ? run.artifacts.map((a) => `<a href="${escapeHtml(a.path)}">${escapeHtml(a.name)}</a>`).join(", ")
        : "—";
      const verdict =
        run.verdict.baseline === null
          ? '<span class="muted">first run</span>'
          : run.verdict.regressions > 0
            ? verdictPill("regressed")
            : run.verdict.improvements > 0
              ? verdictPill("improved")
              : verdictPill("neutral");
      return `<tr>
  <th scope="row">${escapeHtml(run.label ?? run.stem)}<div class="muted small"><code>${escapeHtml(run.stem)}</code></div></th>
  <td>${escapeHtml(dateTime(run.startedAt))}</td>
  <td>${escapeHtml(run.branch ?? "—")}${run.commitSha ? ` <code>${escapeHtml(run.commitSha.slice(0, 7))}</code>` : ""}</td>
  <td>${escapeHtml(run.source)}</td>
  <td>${verdict}</td>
  <td>${artifacts}</td>
  <td>${run.cloudUrl ? `<a href="${escapeHtml(run.cloudUrl)}">synced</a>` : '<span class="muted">local</span>'}</td>
</tr>`;
    })
    .join("\n");
  return `<section><p class="eyebrow">Runs</p><h2>${data.runs.length} local run${data.runs.length === 1 ? "" : "s"}</h2>
  <div class="scroll"><table>
    <thead><tr><th>Run</th><th>When</th><th>Branch</th><th>Source</th><th>Verdict</th><th>Artifacts</th><th>Cloud</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div></section>`;
}

const STYLE = `
:root { color-scheme: light; --paper:#fbfbf8; --raise:#f3f2ec; --ink:#1b1b18; --body:#3c3b36; --soft:#6f6e66; --line:#e1e0d9;
  --good:#0a7d0a; --bad:#c02f2f; --viz-good:#0ca30c; --viz-critical:#d03b3b; --viz-neutral:#898781; --viz-warning:#a06600;
  --ts-chart-tooltip-background:#fff; --ts-chart-tooltip-color:#1b1b18; --ts-chart-tooltip-border:1px solid #e1e0d9;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark; --paper:#141413; --raise:#1d1d1b; --ink:#f1f0ea;
  --body:#cfcec6; --soft:#9a9990; --line:#2c2c2a; --good:#4cc94c; --bad:#f06a6a; --viz-warning:#e0a12c;
  --ts-chart-tooltip-background:#1d1d1b; --ts-chart-tooltip-color:#f1f0ea; --ts-chart-tooltip-border:1px solid #383835; } }
:root[data-theme="dark"] { color-scheme: dark; --paper:#141413; --raise:#1d1d1b; --ink:#f1f0ea; --body:#cfcec6; --soft:#9a9990; --line:#2c2c2a;
  --good:#4cc94c; --bad:#f06a6a; --viz-warning:#e0a12c; --ts-chart-tooltip-background:#1d1d1b; --ts-chart-tooltip-color:#f1f0ea;
  --ts-chart-tooltip-border:1px solid #383835; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--body); font: 15px/1.55 var(--sans); }
main { max-width: 72rem; margin: 0 auto; padding: 2rem 16px 4rem; }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 1.5rem; }
h1 { margin: 0; font-size: 1.7rem; letter-spacing: -0.03em; color: var(--ink); }
h2 { margin: 0.2rem 0 0.6rem; font-size: 1.2rem; color: var(--ink); letter-spacing: -0.02em; }
section { margin-top: 2.2rem; }
.eyebrow { margin: 0; font: 500 0.7rem/1.2 var(--mono); text-transform: uppercase; letter-spacing: 0.1em; color: var(--soft); }
.lede { margin: 0 0 1rem; color: var(--ink); } .lede--bad { color: var(--bad); font-weight: 600; }
.muted { color: var(--soft); } .small { font-size: 0.78rem; }
code { font: 0.85em var(--mono); color: var(--ink); background: var(--raise); padding: 0.05em 0.3em; border-radius: 0.25rem; }
.scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 0.6rem; }
table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
th, td { text-align: left; padding: 0.55rem 0.75rem; border-bottom: 1px solid var(--line); vertical-align: top; }
thead th { font: 500 0.7rem/1.2 var(--mono); text-transform: uppercase; letter-spacing: 0.08em; color: var(--soft); background: var(--raise); }
tbody tr:last-child > * { border-bottom: 0; }
tbody th { font-weight: 500; color: var(--ink); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.pill { display: inline-block; padding: 0.05rem 0.5rem; border-radius: 999px; font: 600 0.72rem/1.5 var(--mono); border: 1px solid currentColor; }
.pill--regressed { color: var(--bad); } .pill--improved { color: var(--good); } .pill--neutral { color: var(--soft); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 30rem), 1fr)); gap: 1rem; }
.card { margin: 0; padding: 0.9rem 1rem; border: 1px solid var(--line); border-radius: 0.6rem; background: var(--paper); }
.card figcaption { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: baseline; margin-bottom: 0.5rem; color: var(--ink); font-size: 0.9rem; }
.chart { min-height: 240px; color: var(--soft); }
a { color: var(--ink); }
button.theme { font: 500 0.8rem var(--mono); color: var(--ink); background: var(--raise); border: 1px solid var(--line); border-radius: 0.5rem; padding: 0.4rem 0.7rem; cursor: pointer; }
.note { margin-top: 2.5rem; font-size: 0.8rem; color: var(--soft); }
`;

const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("benchable-report-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;}catch(e){}})();
function benchableToggleTheme(){var r=document.documentElement;var dark=r.dataset.theme?r.dataset.theme==="dark":matchMedia("(prefers-color-scheme: dark)").matches;var next=dark?"light":"dark";r.dataset.theme=next;try{localStorage.setItem("benchable-report-theme",next);}catch(e){}}`;

export function renderReport(data: ReportData, bundle: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(data.title)} benchmarks</title>
<meta name="generator" content="benchable local report">
<script>${THEME_SCRIPT}</script>
<style>${STYLE}</style>
</head>
<body>
<main>
  <header>
    <div>
      <p class="eyebrow">Benchable · local report</p>
      <h1>${escapeHtml(data.title)}</h1>
      <p class="muted small">Generated ${escapeHtml(dateTime(data.generatedAt))}</p>
    </div>
    <button class="theme" type="button" onclick="benchableToggleTheme()" aria-label="Toggle light and dark theme">Theme</button>
  </header>
  ${latestSection(data)}
  ${metricSections(data)}
  ${runsSection(data)}
  <p class="note">Verdicts compare each run with the latest earlier run on the same branch, using a ±5% noise band and
  Mann–Whitney U (raw samples) or Welch's t (mean, stddev, n) when both runs carry a distribution. The cloud also learns
  a noise band per metric and applies false-discovery control; <code>benchable local sync</code> uploads this history.</p>
</main>
<script id="benchable-data" type="application/json">${embedJson(data)}</script>
<script>${embedScript(bundle)}</script>
</body>
</html>
`;
}
