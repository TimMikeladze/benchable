import { describe, expect, test } from "bun:test";

import { classify, percentChange, severity, summarize } from "../src/comparison";

describe("percentChange", () => {
  test("is relative to the magnitude of the baseline", () => {
    expect(percentChange(110, 100)).toBe(10);
    expect(percentChange(90, 100)).toBe(-10);
  });

  test("is undefined when the baseline is zero", () => {
    expect(percentChange(5, 0)).toBeNull();
  });

  test("uses the absolute baseline so a negative baseline keeps the sign of the move", () => {
    expect(percentChange(-5, -10)).toBe(50);
  });
});

describe("classify", () => {
  test("has no verdict without a baseline", () => {
    const delta = classify(120, null, "lower", 5);
    expect(delta.verdict).toBe("neutral");
    expect(delta.deltaPct).toBeNull();
    expect(delta.baseline).toBeNull();
  });

  test("calls a rise a regression when lower is better", () => {
    expect(classify(120, 100, "lower", 5).verdict).toBe("regressed");
    expect(classify(80, 100, "lower", 5).verdict).toBe("improved");
  });

  test("inverts for higher-is-better metrics", () => {
    expect(classify(120, 100, "higher", 5).verdict).toBe("improved");
    expect(classify(80, 100, "higher", 5).verdict).toBe("regressed");
  });

  test("treats a move inside the threshold as noise", () => {
    expect(classify(104, 100, "lower", 5).verdict).toBe("neutral");
    expect(classify(106, 100, "lower", 5).verdict).toBe("regressed");
  });

  test("a zero threshold still calls an exactly equal value unchanged", () => {
    expect(classify(100, 100, "lower", 0).verdict).toBe("neutral");
    expect(classify(100.1, 100, "lower", 0).verdict).toBe("regressed");
  });

  test("falls back to the sign of the raw delta when the baseline is zero", () => {
    expect(classify(3, 0, "lower", 5).verdict).toBe("regressed");
    expect(classify(-3, 0, "lower", 5).verdict).toBe("improved");
    expect(classify(0, 0, "lower", 5).verdict).toBe("neutral");
  });
});

describe("severity", () => {
  test("ranks regressions above improvements", () => {
    const regressed = classify(150, 100, "lower", 5);
    const improved = classify(50, 100, "lower", 5);
    const neutral = classify(101, 100, "lower", 5);
    expect(severity(regressed)).toBeGreaterThan(severity(neutral));
    expect(severity(neutral)).toBeGreaterThan(severity(improved));
  });
});

describe("summarize", () => {
  test("counts each verdict", () => {
    const deltas = [
      classify(150, 100, "lower", 5),
      classify(50, 100, "lower", 5),
      classify(101, 100, "lower", 5),
      classify(10, null, "lower", 5),
    ];
    expect(summarize(deltas)).toEqual({ regressed: 1, improved: 1, neutral: 2 });
  });
});

describe("classify with distribution evidence", () => {
  const noisy = { stddev: 12, samples: 8 };
  const tight = { stddev: 0.3, samples: 20 };

  test("a move past the threshold on a noisy metric is not a regression", () => {
    const delta = classify(106, 100, "lower", 5, {
      current: noisy,
      baseline: { stddev: 11, samples: 8 },
    });
    expect(delta.verdict).toBe("neutral");
    expect(delta.reason).toContain("not significant");
    expect(delta.significance?.test).toBe("welch");
    expect(delta.significance?.significant).toBe(false);
    // Still a candidate: this is the set false-discovery control reasons about.
    expect(delta.candidate).toBe(true);
  });

  test("a small move on a rock-steady metric survives the test", () => {
    const delta = classify(106, 100, "lower", 5, {
      current: tight,
      baseline: { stddev: 0.35, samples: 20 },
    });
    expect(delta.verdict).toBe("regressed");
    expect(delta.significance?.significant).toBe(true);
    expect(delta.significance?.p).toBeLessThan(0.001);
    expect(delta.significance?.effectSize).not.toBeNull();
    expect(delta.significance?.interval?.low).toBeGreaterThan(0);
    expect(delta.reason).toContain("p < 0.001");
  });

  test("evidence never promotes a move that is inside the noise band", () => {
    const delta = classify(101, 100, "lower", 5, {
      current: tight,
      baseline: { stddev: 0.3, samples: 20 },
    });
    expect(delta.verdict).toBe("neutral");
    expect(delta.reason).toContain("noise band");
    // No test was run at all: the band decides first, so there is nothing to report.
    expect(delta.significance).toBeUndefined();
  });

  test("raw samples are tested with mann-whitney rather than welch", () => {
    const baselineValues = [100, 101, 99, 102, 98, 100, 101, 99];
    const currentValues = [130, 131, 129, 132, 128, 130, 131, 129];
    const delta = classify(130, 100, "lower", 5, {
      current: { values: currentValues, stddev: 1.3, samples: 8 },
      baseline: { values: baselineValues, stddev: 1.3, samples: 8 },
    });
    expect(delta.significance?.test).toBe("mann-whitney");
    expect(delta.verdict).toBe("regressed");
  });

  test("a measured noise band overrides the configured threshold", () => {
    // The metric is configured at 5% but actually swings ±20% run to run.
    const delta = classify(112, 100, "lower", 5, { noiseBandPct: 20 });
    expect(delta.verdict).toBe("neutral");
    expect(delta.noiseBandPct).toBe(20);
    expect(delta.reason).toContain("±20%");
  });

  test("half-reported evidence falls back to percent change", () => {
    const delta = classify(120, 100, "lower", 5, { current: tight, baseline: null });
    expect(delta.verdict).toBe("regressed");
    expect(delta.significance).toBeUndefined();
    expect(delta.reason).toContain("moved more than");
  });
});
