import { describe, expect, test } from "bun:test";

import {
  compactNumber,
  formatBytes,
  formatDelta,
  formatDuration,
  formatPercent,
  formatValue,
  shortSha,
} from "../src/format";

describe("compactNumber", () => {
  test("shortens large numbers and keeps precision on small ones", () => {
    expect(compactNumber(24_100)).toBe("24.10k");
    expect(compactNumber(1_500_000)).toBe("1.50M");
    expect(compactNumber(118.42)).toBe("118");
    expect(compactNumber(1.234)).toBe("1.23");
    expect(compactNumber(0)).toBe("0");
  });
});

describe("formatValue", () => {
  test("appends the unit", () => {
    expect(formatValue(12, null)).toBe("12.00");
    expect(formatValue(99.5, "%")).toBe("99.50%");
    expect(formatValue(24_100, "ops/s")).toBe("24.10k ops/s");
  });

  test("rescales durations instead of compacting them", () => {
    expect(formatValue(118.4, "ms")).toBe("118.4ms");
    expect(formatValue(39_420, "ms")).toBe("39.42s");
    expect(formatValue(2.5, "s")).toBe("2.50s");
    expect(formatValue(1500, "ns")).toBe("1.50µs");
  });

  test("rescales byte units", () => {
    expect(formatBytes(1536, "b")).toBe("1.50 KB");
    expect(formatValue(2048, "kb")).toBe("2.00 MB");
  });
});

describe("formatDuration", () => {
  test("picks a unit that keeps the number readable", () => {
    expect(formatDuration(0.4)).toBe("400µs");
    expect(formatDuration(0.0015)).toBe("1.50µs");
    expect(formatDuration(42.5)).toBe("42.5ms");
    expect(formatDuration(1500)).toBe("1.50s");
    expect(formatDuration(65_000)).toBe("1m 5s");
  });
});

describe("formatPercent and formatDelta", () => {
  test("signs the change and marks an absent one", () => {
    expect(formatPercent(4.21)).toBe("+4.21%");
    expect(formatPercent(-12.5)).toBe("-12.5%");
    expect(formatPercent(null)).toBe("—");
    expect(formatDelta(-8, "ms")).toBe("−8.00ms");
    expect(formatDelta(null)).toBe("—");
  });
});

describe("shortSha", () => {
  test("keeps seven characters", () => {
    expect(shortSha("9f3c1ab8d2e4")).toBe("9f3c1ab");
    expect(shortSha(null)).toBeNull();
  });
});
