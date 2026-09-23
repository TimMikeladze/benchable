/**
 * Benchable SDK. One dependency-free file: it imports nothing, so it can be vendored on its
 * own. It runs anywhere `fetch` exists: Bun, Node 18+, Deno, the browser.
 *
 * `RunInput`'s metric shape mirrors the ingest schema (`src/schema.ts`), which the server
 * validates against; `tests/sdk-types.test.ts` fails the typecheck if the two drift apart.
 */

export type MetricDirection = "lower" | "higher";

export type MetricInput =
  | number
  | {
      value: number;
      unit?: string;
      direction?: MetricDirection;
      name?: string;
      description?: string;
      samples?: number;
      min?: number;
      max?: number;
      mean?: number;
      p50?: number;
      p95?: number;
      p99?: number;
      stddev?: number;
      /** Raw samples. With both sides sending these, the comparison uses Mann–Whitney U. */
      values?: number[];
      labels?: Record<string, string>;
    };

export interface SpanInput {
  id: string;
  parentId?: string | null;
  name: string;
  startMs: number;
  durationMs: number;
  status?: "ok" | "error";
  attributes?: Record<string, unknown>;
}

export interface BenchableOptions {
  /** A project API key, from Settings → API Keys. */
  apiKey: string;
  /** Default `https://benchable.sh`. Point this at a self-hosted deploy. */
  baseUrl?: string;
}

export interface RunInput {
  label?: string;
  commitSha?: string;
  branch?: string;
  environment?: string;
  source?: string;
  /** ISO 8601. Defaults to the time the server receives the request. */
  startedAt?: string;
  metadata?: Record<string, unknown>;
  metrics: Record<string, MetricInput>;
  spans?: SpanInput[];
  /** Reused on retry so a re-run of the same CI step returns the original verdict. */
  idempotencyKey?: string;
}

export interface RunResult {
  runId: string;
  regressions: number;
  budgetFailures: number;
  body: unknown;
}

export class BenchableError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "BenchableError";
  }
}

export class Benchable {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: BenchableOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://benchable.sh").replace(/\/+$/, "");
  }

  /** `POST /api/v1/runs` — the native payload. */
  async run(input: RunInput): Promise<RunResult> {
    const { idempotencyKey, ...payload } = input;
    return this.post("/api/v1/runs", JSON.stringify(payload), {
      "content-type": "application/json",
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    });
  }

  /** `POST /api/v1/import` — a tool's own output, auto-detected unless `format` names one. */
  async import(
    format: string,
    body: string,
    options: { contentType?: string; idempotencyKey?: string } = {},
  ): Promise<RunResult> {
    const query = format === "auto" ? "" : `?format=${encodeURIComponent(format)}`;
    return this.post(`/api/v1/import${query}`, body, {
      "content-type": options.contentType ?? "text/plain",
      ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
    });
  }

  private async post(path: string, body: string, headers: Record<string, string>): Promise<RunResult> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      body,
      headers: { authorization: `Bearer ${this.apiKey}`, accept: "application/json", ...headers },
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new BenchableError(
        (parsed && typeof parsed === "object" && "message" in parsed && String(parsed.message)) ||
          `Benchable request failed: ${response.status}`,
        response.status,
        parsed,
      );
    }
    return {
      runId: response.headers.get("x-benchable-run-id") ?? "",
      regressions: Number(response.headers.get("x-benchable-regressions") ?? 0),
      budgetFailures: Number(response.headers.get("x-benchable-budget-failures") ?? 0),
      body: parsed,
    };
  }
}
