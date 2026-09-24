import { benchable } from "./adapters/benchable";
import { chromeTrace } from "./adapters/chrome-trace";
import { criterion } from "./adapters/criterion";
import { csv } from "./adapters/csv";
import { goBench } from "./adapters/go-bench";
import { googleBenchmark } from "./adapters/google-benchmark";
import { hyperfine } from "./adapters/hyperfine";
import { jaeger } from "./adapters/jaeger";
import { jmh } from "./adapters/jmh";
import { k6 } from "./adapters/k6";
import { lighthouse } from "./adapters/lighthouse";
import { otlpTrace } from "./adapters/otlp-trace";
import { prometheus } from "./adapters/prometheus";
import { pytestBenchmark } from "./adapters/pytest-benchmark";
import { vitestBench } from "./adapters/vitest-bench";
import { zipkin } from "./adapters/zipkin";
import { FormatParseError, type FormatAdapter, type FormatId, type FormatInput, type ParsedRun } from "./types";

/**
 * Detection order matters: the specific shapes come first, and the two permissive text
 * formats (prometheus, csv) come last so they only claim input nothing else recognized.
 */
export const ADAPTERS: readonly FormatAdapter[] = [
  benchable,
  otlpTrace,
  jaeger,
  zipkin,
  chromeTrace,
  lighthouse,
  googleBenchmark,
  pytestBenchmark,
  hyperfine,
  jmh,
  k6,
  vitestBench,
  criterion,
  goBench,
  prometheus,
  csv,
];

const BY_ID = new Map<FormatId, FormatAdapter>(ADAPTERS.map((adapter) => [adapter.id, adapter]));

export function getAdapter(id: FormatId): FormatAdapter | undefined {
  return BY_ID.get(id);
}

export function isFormatId(value: string): value is FormatId {
  return BY_ID.has(value as FormatId);
}

export function toFormatInput(raw: string): FormatInput {
  let json: unknown = null;
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      json = JSON.parse(trimmed);
    } catch {
      // Not JSON, or truncated. Text adapters still get a shot at it.
      json = null;
    }
  }
  return { raw, json };
}

/** First adapter whose `detect` claims the input. A throwing `detect` is treated as "no". */
export function detectFormat(input: FormatInput): FormatAdapter | null {
  for (const adapter of ADAPTERS) {
    try {
      if (adapter.detect(input)) return adapter;
    } catch {
      continue;
    }
  }
  return null;
}

export interface ParseResult {
  run: ParsedRun;
  adapter: FormatAdapter;
}

/**
 * Parse a raw body. An explicit `format` skips detection so the caller gets a real parse
 * error instead of silently falling through to a more permissive adapter.
 */
export function parseRaw(raw: string, format: FormatId | "auto" = "auto"): ParseResult {
  const input = toFormatInput(raw);

  if (format !== "auto") {
    const adapter = getAdapter(format);
    if (!adapter) throw new FormatParseError(`Unknown format ${format}`, "benchable");
    return { run: adapter.parse(input), adapter };
  }

  const adapter = detectFormat(input);
  if (!adapter) {
    throw new FormatParseError(
      `Could not recognize this input. Supported formats: ${ADAPTERS.map((a) => a.id).join(", ")}`,
      "benchable",
    );
  }
  return { run: adapter.parse(input), adapter };
}

export { FormatParseError };
export type { FormatAdapter, FormatId, FormatInput, ParsedRun } from "./types";
