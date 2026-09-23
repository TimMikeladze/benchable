import {
  cohensD,
  mannWhitneyU,
  meanDifferenceInterval,
  type Interval,
  type SummaryStats,
  welchT,
} from "./statistics";

export type MetricDirection = "lower" | "higher";
export type Verdict = "improved" | "regressed" | "neutral";

/** What the producer told us about this measurement's distribution, if anything. */
export interface DistributionEvidence {
  stddev?: number | null;
  samples?: number | null;
  /** Raw sample vector, when the producer sent one. Preferred over the summary. */
  values?: readonly number[] | null;
}

export interface ChangeEvidence {
  current?: DistributionEvidence | null;
  baseline?: DistributionEvidence | null;
  /**
   * The dead band to use instead of the metric's configured threshold — the band measured
   * from the metric's own history. Resolved by the caller, because only it knows whether the
   * metric is in `auto` mode.
   */
  noiseBandPct?: number | null;
  /** Significance level for the test. 0.05 unless a caller has a reason. */
  alpha?: number;
}

export interface Significance {
  test: "welch" | "mann-whitney";
  p: number;
  /** Cohen's d, where both sides had a summary. Effect size is the number a human reads. */
  effectSize: number | null;
  /** Confidence interval on the difference of means, in the metric's own unit. */
  interval: Interval | null;
  /** True when the test cleared `alpha`. */
  significant: boolean;
}

export interface Delta {
  value: number;
  baseline: number | null;
  delta: number | null;
  deltaPct: number | null;
  verdict: Verdict;
  /** Why this verdict, in words. Shown in the UI and the digests instead of a bare arrow. */
  reason?: string;
  /** Present only when the data supported a test. */
  significance?: Significance | null;
  /** The dead band actually applied, which may be the measured one rather than the setting. */
  noiseBandPct?: number;
  /**
   * The p-value after false-discovery control across the run's other tested metrics. Present
   * only on runs large enough for control to have been applied.
   */
  adjustedP?: number;
  /**
   * Set when a move cleared the noise band but the test said it was not real, or it did not
   * survive false-discovery control. These are the candidates FDR reasons about.
   */
  candidate?: boolean;
}

const DEFAULT_ALPHA = 0.05;

/**
 * Percent change from baseline to value. A baseline of exactly 0 has no defined percent
 * change, so we report the absolute delta and let the verdict fall back to sign alone.
 */
export function percentChange(value: number, baseline: number): number | null {
  if (baseline === 0) return null;
  return ((value - baseline) / Math.abs(baseline)) * 100;
}

function toSummary(
  value: number,
  evidence: DistributionEvidence | null | undefined,
): SummaryStats | null {
  if (!evidence) return null;
  const { stddev, samples } = evidence;
  if (typeof stddev !== "number" || !Number.isFinite(stddev)) return null;
  if (typeof samples !== "number" || !Number.isFinite(samples) || samples < 2) return null;
  return { mean: value, stddev, n: samples };
}

/**
 * Run the strongest test the two sides support.
 *
 * Raw samples beat a summary: benchmark timings are right-skewed with a hard floor, so
 * Mann–Whitney — which assumes no distribution at all — is the honest test when we have the
 * vectors. Falling back to Welch's t over `{mean, stddev, n}` covers every tool that reports
 * a summary instead, which is most of them.
 */
function runTest(
  value: number,
  baseline: number,
  evidence: ChangeEvidence | undefined,
  alpha: number,
): Significance | null {
  const currentValues = evidence?.current?.values ?? null;
  const baselineValues = evidence?.baseline?.values ?? null;

  if (currentValues && baselineValues) {
    const result = mannWhitneyU(currentValues, baselineValues);
    if (result) {
      const current = toSummary(value, evidence?.current);
      const previous = toSummary(baseline, evidence?.baseline);
      return {
        test: result.test,
        p: result.p,
        effectSize: current && previous ? cohensD(current, previous) : null,
        interval: current && previous ? meanDifferenceInterval(current, previous) : null,
        significant: result.p < alpha,
      };
    }
  }

  const current = toSummary(value, evidence?.current);
  const previous = toSummary(baseline, evidence?.baseline);
  if (!current || !previous) return null;

  const result = welchT(current, previous);
  if (!result) return null;

  return {
    test: result.test,
    p: result.p,
    effectSize: cohensD(current, previous),
    interval: meanDifferenceInterval(current, previous),
    significant: result.p < alpha,
  };
}

function formatP(p: number): string {
  return p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(3)}`;
}

/**
 * Classify a change.
 *
 * The dead band comes first: anything smaller than the band is noise whatever a test says,
 * because a statistically detectable 0.4% move is still not worth waking anyone for. Past the
 * band, if both sides carry a distribution we ask whether the difference is real before
 * calling it a result — a 6% move on a metric that swings ±12% run to run is not a regression,
 * and saying so is the difference between an alert people act on and one they mute.
 *
 * Evidence can only ever downgrade a verdict to neutral or annotate it. Without evidence this
 * behaves exactly as it did before: percent change against the threshold.
 */
export function classify(
  value: number,
  baseline: number | null,
  direction: MetricDirection,
  thresholdPct: number,
  evidence?: ChangeEvidence,
): Delta {
  if (baseline === null || !Number.isFinite(baseline)) {
    return {
      value,
      baseline: null,
      delta: null,
      deltaPct: null,
      verdict: "neutral",
      reason: "first run",
    };
  }

  const band =
    typeof evidence?.noiseBandPct === "number" && Number.isFinite(evidence.noiseBandPct)
      ? evidence.noiseBandPct
      : thresholdPct;
  const alpha = evidence?.alpha ?? DEFAULT_ALPHA;
  const delta = value - baseline;
  const deltaPct = percentChange(value, baseline);
  const base = { value, baseline, delta, deltaPct, noiseBandPct: band };

  // An identical value is never a result, whatever the threshold is set to.
  if (delta === 0) return { ...base, verdict: "neutral", reason: "unchanged" };

  const magnitude = deltaPct === null ? Infinity : Math.abs(deltaPct);
  if (magnitude < band) {
    return { ...base, verdict: "neutral", reason: `within the ±${trim(band)}% noise band` };
  }

  const gotBigger = delta > 0;
  const better = direction === "lower" ? !gotBigger : gotBigger;
  const verdict: Verdict = better ? "improved" : "regressed";

  const significance = runTest(value, baseline, evidence, alpha);
  if (!significance) {
    return { ...base, verdict, reason: `moved more than the ±${trim(band)}% noise band` };
  }

  if (!significance.significant) {
    return {
      ...base,
      verdict: "neutral",
      significance,
      candidate: true,
      reason: `not significant (${formatP(significance.p)})`,
    };
  }

  const effect =
    significance.effectSize === null
      ? ""
      : `, d = ${Math.abs(significance.effectSize).toFixed(2)}`;
  return {
    ...base,
    verdict,
    significance,
    candidate: true,
    reason: `significant (${formatP(significance.p)}${effect})`,
  };
}

function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** Sort key that puts the worst regressions first, then the biggest improvements. */
export function severity(delta: Delta): number {
  if (delta.verdict === "neutral" || delta.deltaPct === null) return 0;
  const magnitude = Math.abs(delta.deltaPct);
  return delta.verdict === "regressed" ? magnitude : -magnitude;
}

export function summarize(deltas: readonly Delta[]) {
  return {
    regressed: deltas.filter((d) => d.verdict === "regressed").length,
    improved: deltas.filter((d) => d.verdict === "improved").length,
    neutral: deltas.filter((d) => d.verdict === "neutral").length,
  };
}
