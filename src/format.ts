/** Multipliers into milliseconds, so any time unit can be rescaled for display. */
const TIME_UNITS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  "µs": 1e-3,
  ms: 1,
  s: 1000,
  sec: 1000,
  m: 60_000,
  min: 60_000,
};
const BYTE_UNITS = new Set(["bytes", "b", "kb", "mb", "gb"]);

/** Compact number for axis ticks and cards: 1234 -> 1.23k. */
export function compactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(2)}k`;
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 1) return value.toFixed(2);
  if (abs === 0) return "0";
  return value.toPrecision(3);
}

export function formatValue(value: number, unit?: string | null): string {
  const normalized = unit?.toLowerCase();
  if (normalized === "%") return `${compactNumber(value)}%`;
  if (normalized && BYTE_UNITS.has(normalized)) return formatBytes(value, normalized);
  // A duration is rescaled rather than compacted: 39420 ms reads as 39.42s, not 39.42k ms.
  if (normalized && normalized in TIME_UNITS) {
    return formatDuration(value * TIME_UNITS[normalized]);
  }
  return unit ? `${compactNumber(value)} ${unit}` : compactNumber(value);
}

export function formatBytes(value: number, unit: string): string {
  const multiplier =
    unit === "kb" ? 1024 : unit === "mb" ? 1024 ** 2 : unit === "gb" ? 1024 ** 3 : 1;
  let bytes = value * multiplier;
  const scale = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  while (Math.abs(bytes) >= 1024 && index < scale.length - 1) {
    bytes /= 1024;
    index += 1;
  }
  return `${bytes.toFixed(index === 0 ? 0 : 2)} ${scale[index]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1) {
    const micros = ms * 1000;
    return `${micros.toFixed(micros < 10 ? 2 : 0)}µs`;
  }
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : 1)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.floor(ms / 60_000)}m ${((ms % 60_000) / 1000).toFixed(0)}s`;
}

export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(Math.abs(value) < 10 ? 2 : 1)}%`;
}

export function formatDelta(delta: number | null, unit?: string | null): string {
  if (delta === null || !Number.isFinite(delta)) return "—";
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
  return `${sign}${formatValue(Math.abs(delta), unit)}`;
}

export function shortSha(sha?: string | null): string | null {
  return sha ? sha.slice(0, 7) : null;
}
