import type { SpanPayload } from "../schema";

export type FormatId =
  | "benchable"
  | "go-bench"
  | "hyperfine"
  | "pytest-benchmark"
  | "google-benchmark"
  | "criterion"
  | "vitest-bench"
  | "k6"
  | "lighthouse"
  | "jmh"
  | "prometheus"
  | "csv"
  | "otlp-trace"
  | "jaeger"
  | "zipkin"
  | "chrome-trace";

export interface MetricValue {
  value: number;
  unit?: string;
  direction?: "lower" | "higher";
  name?: string;
  samples?: number;
  min?: number;
  max?: number;
  mean?: number;
  p50?: number;
  p95?: number;
  p99?: number;
  stddev?: number;
  /** Raw samples, when the tool reports them. Lets a comparison use Mann–Whitney. */
  values?: number[];
  labels?: Record<string, string>;
}

export interface FormatInput {
  /** The body exactly as received. */
  raw: string;
  /** Parsed body when it was valid JSON, otherwise null. Parsed once, shared by adapters. */
  json: unknown;
}

export interface ParsedRun {
  format: FormatId;
  metrics: Record<string, MetricValue>;
  spans?: SpanPayload[];
  metadata?: Record<string, unknown>;
  label?: string;
  startedAt?: Date;
  /** Only the native payload carries these; the import path uses them unless overridden. */
  branch?: string;
  commitSha?: string;
  environment?: string;
  idempotencyKey?: string;
}

export interface FormatAdapter {
  id: FormatId;
  label: string;
  /** One line, shown in the UI and in `llms.txt`. */
  description: string;
  /** How a user produces this file. */
  produce: string;
  /**
   * Cheap shape check used by `format=auto`. Must never throw, however hostile the input —
   * detection runs against every uploaded body.
   */
  detect(input: FormatInput): boolean;
  /** Throws `FormatParseError` when the input matches the shape but is unusable. */
  parse(input: FormatInput): ParsedRun;
}

export class FormatParseError extends Error {
  constructor(
    message: string,
    readonly format: FormatId,
  ) {
    super(message);
    this.name = "FormatParseError";
  }
}
