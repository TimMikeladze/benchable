/**
 * The statistics a benchmarking product needs, with no dependency.
 *
 * Everything here is a pure function over numbers. The approximations are the standard ones
 * (Lanczos log-gamma, Lentz continued fraction for the incomplete beta, Abramowitz–Stegun for
 * the error function) and are accurate to far more digits than a p-value is ever read to.
 *
 * Two shapes of input show up, and both matter:
 *
 * - **Summary statistics** — `{ mean, stddev, n }`. This is what a benchmark tool emits:
 *   hyperfine, JMH, pytest-benchmark and Google Benchmark all report mean and stddev over N
 *   iterations rather than the samples themselves. Welch's t-test is the right test here.
 * - **Raw samples** — the vector. Micro-benchmark distributions are heavy-tailed and not
 *   normal, so when we have the samples we prefer Mann–Whitney U, which assumes neither.
 */

export interface SummaryStats {
  mean: number;
  /** Sample standard deviation (n − 1 denominator), as every benchmark tool reports it. */
  stddev: number;
  /** Number of iterations behind the mean. */
  n: number;
}

/* -------------------------------------------------------------------------- */
/*                             Descriptive statistics                         */
/* -------------------------------------------------------------------------- */

export function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/**
 * Quantile by linear interpolation between order statistics (the "type 7" definition R and
 * NumPy default to), so a p95 computed here matches the one a producer computed there.
 */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  if (values.length === 1) return values[0];
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function median(values: readonly number[]): number {
  return quantile(values, 0.5);
}

/** Sample standard deviation. Fewer than two points has no spread, not a spread of zero. */
export function stddev(values: readonly number[]): number {
  if (values.length < 2) return Number.NaN;
  const average = mean(values);
  let sum = 0;
  for (const value of values) sum += (value - average) ** 2;
  return Math.sqrt(sum / (values.length - 1));
}

/**
 * Median absolute deviation, scaled by 1.4826 so it estimates the same quantity as σ for
 * normal data. Robust: one catastrophic outlier — a CI runner that got descheduled mid-run —
 * moves the standard deviation a long way and this not at all.
 */
export function mad(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const center = median(values);
  const deviations = values.map((value) => Math.abs(value - center));
  return median(deviations) * 1.4826;
}

/** Coefficient of variation as a percentage. Undefined around a zero mean. */
export function coefficientOfVariation(values: readonly number[]): number | null {
  const average = mean(values);
  if (!Number.isFinite(average) || average === 0) return null;
  const spread = stddev(values);
  if (!Number.isFinite(spread)) return null;
  return (spread / Math.abs(average)) * 100;
}

/* -------------------------------------------------------------------------- */
/*                              Distribution functions                        */
/* -------------------------------------------------------------------------- */

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** Lanczos approximation, reflected for x < 0.5. */
export function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let sum = 0.99999999999980993;
  for (let i = 0; i < LANCZOS.length; i += 1) sum += LANCZOS[i] / (z + i + 1);
  const t = z + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

/** Continued fraction for the incomplete beta, evaluated with Lentz's method. */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const tiny = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m;
    let numerator = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;

    numerator = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 3e-16) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). The workhorse behind the t-distribution CDF. */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  // The fraction converges quickly only on one side of the symmetry point; reflect otherwise.
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(x, a, b)) / a
    : 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

/** Two-sided p-value for a t statistic with `df` degrees of freedom. */
export function studentTTwoSided(t: number, df: number): number {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return 1;
  const x = df / (df + t * t);
  return Math.min(1, incompleteBeta(x, df / 2, 0.5));
}

/** Abramowitz–Stegun 7.1.26. Absolute error below 1.5e-7, which no p-value cares about. */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-z * z);
  return sign * y;
}

export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/* -------------------------------------------------------------------------- */
/*                                    Tests                                   */
/* -------------------------------------------------------------------------- */

export interface TestResult {
  /** The test statistic: t for Welch, z for Mann–Whitney's normal approximation. */
  statistic: number;
  /** Two-sided p-value. */
  p: number;
  /** Degrees of freedom, where the test has them. */
  df?: number;
  test: "welch" | "mann-whitney";
}

/**
 * Welch's t-test: two means, unequal variances, unequal sample sizes. Student's pooled t
 * assumes the two runs have the same variance, which benchmark runs routinely violate — a
 * noisy afternoon on a shared CI runner has several times the variance of a quiet night.
 *
 * Returns null when either side lacks the spread or the sample count to say anything.
 */
export function welchT(a: SummaryStats, b: SummaryStats): TestResult | null {
  if (!isUsable(a) || !isUsable(b)) return null;

  const varianceA = (a.stddev * a.stddev) / a.n;
  const varianceB = (b.stddev * b.stddev) / b.n;
  const denominator = Math.sqrt(varianceA + varianceB);
  // Two runs that each reported zero spread agree exactly or differ exactly; either way the
  // t statistic is not defined and the percent-change path is the honest answer.
  if (denominator === 0) return null;

  const t = (a.mean - b.mean) / denominator;
  const df =
    (varianceA + varianceB) ** 2 /
    (varianceA ** 2 / (a.n - 1) + varianceB ** 2 / (b.n - 1));
  if (!Number.isFinite(df) || df <= 0) return null;

  return { statistic: t, df, p: studentTTwoSided(t, df), test: "welch" };
}

function isUsable(stats: SummaryStats): boolean {
  return (
    Number.isFinite(stats.mean) &&
    Number.isFinite(stats.stddev) &&
    stats.stddev >= 0 &&
    Number.isFinite(stats.n) &&
    stats.n >= 2
  );
}

/**
 * Mann–Whitney U over raw samples: tie-corrected, normal approximation with a continuity
 * correction. Distribution-free, which is what micro-benchmark timings need — they are
 * right-skewed with a hard floor and a long tail of interrupts, and a t-test on them
 * overstates its confidence.
 */
export function mannWhitneyU(
  a: readonly number[],
  b: readonly number[],
): (TestResult & { u: number }) | null {
  const n1 = a.length;
  const n2 = b.length;
  if (n1 < 3 || n2 < 3) return null;

  const combined = [
    ...a.map((value) => ({ value, group: 0 })),
    ...b.map((value) => ({ value, group: 1 })),
  ].sort((x, y) => x.value - y.value);

  // Average ranks within each tie group, and accumulate the tie correction term.
  const ranks = new Array<number>(combined.length);
  let tieTerm = 0;
  let index = 0;
  while (index < combined.length) {
    let end = index;
    while (end + 1 < combined.length && combined[end + 1].value === combined[index].value) end += 1;
    const size = end - index + 1;
    const averageRank = (index + end + 2) / 2; // ranks are 1-based
    for (let i = index; i <= end; i += 1) ranks[i] = averageRank;
    if (size > 1) tieTerm += size ** 3 - size;
    index = end + 1;
  }

  let rankSumA = 0;
  for (let i = 0; i < combined.length; i += 1) if (combined[i].group === 0) rankSumA += ranks[i];

  const u1 = rankSumA - (n1 * (n1 + 1)) / 2;
  const n = n1 + n2;
  const expected = (n1 * n2) / 2;
  const variance = ((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1)));
  if (variance <= 0) return null;

  // Continuity correction shrinks the gap toward zero by half a unit, clamped so it can
  // never change sign: two identical samples must land on z = 0, not on z = ±0.5/σ.
  const gap = u1 - expected;
  const corrected = Math.sign(gap) * Math.max(0, Math.abs(gap) - 0.5);
  const z = corrected / Math.sqrt(variance);
  return {
    u: u1,
    statistic: z,
    p: Math.min(1, 2 * (1 - normalCdf(Math.abs(z)))),
    test: "mann-whitney",
  };
}

/* -------------------------------------------------------------------------- */
/*                          Effect size and intervals                         */
/* -------------------------------------------------------------------------- */

/**
 * Cohen's d with a pooled standard deviation. Effect size is what a person should read: a
 * p-value only says "the difference is real", d says "and it is this big relative to the
 * noise". 0.2 small, 0.5 medium, 0.8 large, by the usual convention.
 */
export function cohensD(a: SummaryStats, b: SummaryStats): number | null {
  if (!isUsable(a) || !isUsable(b)) return null;
  const pooled = Math.sqrt(
    ((a.n - 1) * a.stddev ** 2 + (b.n - 1) * b.stddev ** 2) / (a.n + b.n - 2),
  );
  if (pooled === 0) return null;
  return (a.mean - b.mean) / pooled;
}

export interface Interval {
  low: number;
  high: number;
  level: number;
}

/**
 * Confidence interval on the difference of two means (Welch). Reported alongside a verdict so
 * the answer to "how much slower?" is a range rather than a single point estimate that the
 * next run will contradict.
 */
export function meanDifferenceInterval(
  a: SummaryStats,
  b: SummaryStats,
  level = 0.95,
): Interval | null {
  const test = welchT(a, b);
  if (!test || test.df === undefined) return null;
  const se = Math.sqrt((a.stddev * a.stddev) / a.n + (b.stddev * b.stddev) / b.n);
  const critical = studentTCritical(1 - (1 - level) / 2, test.df);
  if (!Number.isFinite(critical)) return null;
  const difference = a.mean - b.mean;
  return { low: difference - critical * se, high: difference + critical * se, level };
}

/**
 * Inverse Student-t by bisection. Called once per verdict at most, so a few dozen evaluations
 * of the CDF is cheaper than carrying an inverse-incomplete-beta implementation.
 */
export function studentTCritical(probability: number, df: number): number {
  if (!(probability > 0.5 && probability < 1) || df <= 0) return Number.NaN;
  const target = 2 * (1 - probability); // two-sided tail mass
  let low = 0;
  let high = 1000;
  for (let i = 0; i < 200; i += 1) {
    const middle = (low + high) / 2;
    if (studentTTwoSided(middle, df) > target) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

/* -------------------------------------------------------------------------- */
/*                          Multiple-comparison control                       */
/* -------------------------------------------------------------------------- */

export interface FdrResult {
  /** Per input, in the original order: did this hypothesis survive control? */
  significant: boolean[];
  /** Step-up adjusted p-values (q-values), monotone in the original order. */
  adjusted: number[];
  /** How many survived. */
  count: number;
}

/**
 * Benjamini–Hochberg. A suite reporting 300 metrics at α = 0.05 throws about 15 false alarms
 * per run, which is exactly how a team learns to ignore the alerts. Controlling the false
 * discovery rate instead of the per-test error rate keeps a big suite believable.
 */
export function benjaminiHochberg(pValues: readonly number[], q = 0.05): FdrResult {
  const m = pValues.length;
  if (m === 0) return { significant: [], adjusted: [], count: 0 };

  const order = pValues.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p);

  // Step up from the largest p-value, carrying the running minimum: the adjusted value of a
  // hypothesis can never exceed that of a less significant one.
  const adjusted = new Array<number>(m);
  let runningMin = 1;
  for (let rank = m; rank >= 1; rank -= 1) {
    const { p, index } = order[rank - 1];
    runningMin = Math.min(runningMin, (p * m) / rank);
    adjusted[index] = Math.min(1, runningMin);
  }

  const significant = adjusted.map((value) => value <= q);
  return { significant, adjusted, count: significant.filter(Boolean).length };
}
