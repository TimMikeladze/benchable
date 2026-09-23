/**
 * The statistics core, checked against values a textbook or R would give. These are pure
 * functions with no database, so the whole file runs in milliseconds.
 */
import { describe, expect, test } from "bun:test";

import {
  benjaminiHochberg,
  coefficientOfVariation,
  cohensD,
  incompleteBeta,
  mad,
  mannWhitneyU,
  mean,
  meanDifferenceInterval,
  median,
  normalCdf,
  quantile,
  stddev,
  studentTCritical,
  studentTTwoSided,
  welchT,
} from "../src/statistics";

describe("descriptive statistics", () => {
  test("mean, median and quantiles use the interpolating definition", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(median([1, 2, 3, 4, 5])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    // Type 7: position (n-1)*q, interpolated. p95 of 1..10 is 9.55, not 10.
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBeCloseTo(9.55, 10);
  });

  test("stddev is the sample form and needs two points", () => {
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.1380899, 6);
    expect(Number.isNaN(stddev([5]))).toBe(true);
  });

  test("mad is scaled to estimate sigma and ignores a lone outlier", () => {
    expect(mad([1, 2, 3, 4, 5])).toBeCloseTo(1.4826, 6);
    const clean = [10, 10.1, 9.9, 10.2, 9.8];
    const withOutlier = [...clean, 500];
    // The standard deviation more than doubles; the robust estimate barely moves.
    expect(stddev(withOutlier)).toBeGreaterThan(stddev(clean) * 10);
    expect(mad(withOutlier)).toBeLessThan(mad(clean) * 2);
  });

  test("coefficient of variation is a percentage and undefined at a zero mean", () => {
    expect(coefficientOfVariation([100, 110, 90])).toBeCloseTo(10, 6);
    expect(coefficientOfVariation([-1, 1])).toBeNull();
  });
});

describe("distribution functions", () => {
  test("the incomplete beta matches known values", () => {
    expect(incompleteBeta(0.5, 1, 1)).toBeCloseTo(0.5, 10);
    expect(incompleteBeta(0.5, 2, 3)).toBeCloseTo(0.6875, 8);
    expect(incompleteBeta(0, 2, 3)).toBe(0);
    expect(incompleteBeta(1, 2, 3)).toBe(1);
  });

  test("the t-distribution reproduces the critical values from a t table", () => {
    // t = 2.228 at 10 df is the classic two-sided 5% point.
    expect(studentTTwoSided(2.228, 10)).toBeCloseTo(0.05, 3);
    expect(studentTTwoSided(2.0, 10)).toBeCloseTo(0.0734, 3);
    expect(studentTTwoSided(0, 10)).toBeCloseTo(1, 10);
    expect(studentTCritical(0.975, 10)).toBeCloseTo(2.228, 2);
  });

  test("the normal CDF is accurate enough for a z-based p-value", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 4);
  });
});

describe("welch's t-test", () => {
  test("separates a real shift from run-to-run noise", () => {
    const before = { mean: 10, stddev: 1, n: 10 };
    const after = { mean: 12, stddev: 1.5, n: 10 };
    const result = welchT(after, before)!;

    expect(result.test).toBe("welch");
    expect(result.statistic).toBeCloseTo(3.508, 2);
    // Welch–Satterthwaite: well below the 18 df a pooled test would have claimed.
    expect(result.df).toBeCloseTo(15.68, 1);
    expect(result.p).toBeLessThan(0.01);
  });

  test("a 6% move inside a noisy metric is not significant", () => {
    const before = { mean: 100, stddev: 12, n: 8 };
    const after = { mean: 106, stddev: 11, n: 8 };
    expect(welchT(after, before)!.p).toBeGreaterThan(0.05);
  });

  test("a 2% move on a rock-steady metric is significant", () => {
    const before = { mean: 100, stddev: 0.3, n: 20 };
    const after = { mean: 102, stddev: 0.35, n: 20 };
    expect(welchT(after, before)!.p).toBeLessThan(0.001);
  });

  test("declines to answer without spread or samples", () => {
    expect(welchT({ mean: 10, stddev: 0, n: 5 }, { mean: 12, stddev: 0, n: 5 })).toBeNull();
    expect(welchT({ mean: 10, stddev: 1, n: 1 }, { mean: 12, stddev: 1, n: 5 })).toBeNull();
  });
});

describe("mann-whitney u", () => {
  test("fully separated samples give u = 0 and a small p", () => {
    const result = mannWhitneyU([1, 2, 3, 4, 5], [6, 7, 8, 9, 10])!;
    expect(result.u).toBe(0);
    expect(result.test).toBe("mann-whitney");
    expect(result.p).toBeLessThan(0.05);
  });

  test("identical samples are as far from significant as it gets", () => {
    const samples = [4, 5, 6, 7, 8, 9];
    expect(mannWhitneyU(samples, samples)!.p).toBeCloseTo(1, 8);
  });

  test("ties are rank-corrected rather than broken arbitrarily", () => {
    const result = mannWhitneyU([1, 1, 1, 2, 2], [1, 1, 2, 2, 2])!;
    expect(Number.isFinite(result.p)).toBe(true);
    expect(result.p).toBeGreaterThan(0.05);
  });

  test("needs at least three points a side", () => {
    expect(mannWhitneyU([1, 2], [3, 4])).toBeNull();
  });
});

describe("effect size and intervals", () => {
  test("cohen's d scales the difference by the pooled spread", () => {
    expect(cohensD({ mean: 12, stddev: 1, n: 10 }, { mean: 10, stddev: 1, n: 10 })).toBeCloseTo(2, 6);
  });

  test("a confidence interval that excludes zero agrees with the p-value", () => {
    const after = { mean: 12, stddev: 1.5, n: 10 };
    const before = { mean: 10, stddev: 1, n: 10 };
    const interval = meanDifferenceInterval(after, before)!;

    expect(interval.level).toBe(0.95);
    expect(interval.low).toBeGreaterThan(0);
    expect(interval.low).toBeLessThan(2);
    expect(interval.high).toBeGreaterThan(2);
    expect(welchT(after, before)!.p).toBeLessThan(0.05);
  });
});

describe("benjamini-hochberg", () => {
  test("keeps the strong signals and drops the marginal ones", () => {
    const pValues = [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.216];
    const result = benjaminiHochberg(pValues, 0.05);

    // The textbook answer for this set: the first two survive at q = 0.05.
    expect(result.count).toBe(2);
    expect(result.significant.slice(0, 2)).toEqual([true, true]);
    expect(result.significant[2]).toBe(false);
  });

  test("adjusted values are monotone and never shrink a p-value", () => {
    const pValues = [0.01, 0.02, 0.03, 0.9];
    const { adjusted } = benjaminiHochberg(pValues);
    for (let i = 0; i < pValues.length; i += 1) {
      expect(adjusted[i]).toBeGreaterThanOrEqual(pValues[i] - 1e-12);
    }
    expect(adjusted[0]).toBeLessThanOrEqual(adjusted[3]);
  });

  test("a single hypothesis is unadjusted, and an empty set is empty", () => {
    expect(benjaminiHochberg([0.04]).adjusted[0]).toBeCloseTo(0.04, 10);
    expect(benjaminiHochberg([]).count).toBe(0);
  });

  test("300 pure-noise metrics produce no discoveries", () => {
    // Uniform p-values are what "nothing is happening" looks like; BH should find nothing.
    const pValues = Array.from({ length: 300 }, (_, i) => (i + 0.5) / 300);
    expect(benjaminiHochberg(pValues, 0.05).count).toBe(0);
  });
});
