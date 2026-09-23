import { runPayloadSchema } from "../../schema";

import { FormatParseError, type FormatAdapter, type MetricValue } from "../types";
import { isRecord } from "../util";

/** The native payload, so `format=auto` handles our own shape like any other. */
export const benchable: FormatAdapter = {
  id: "benchable",
  label: "Benchable",
  description: "The native payload: a metrics object, with optional spans and metadata.",
  produce: 'echo \'{"metrics":{"build.time_ms":4210}}\'',

  detect(input) {
    if (!isRecord(input.json) || !isRecord(input.json.metrics)) return false;
    // Validate rather than sniff: other formats also have a top-level `metrics` object
    // (k6, for one), and only ours has a bare number or a `value` under every key.
    return runPayloadSchema.safeParse(input.json).success;
  },

  parse(input) {
    const parsed = runPayloadSchema.safeParse(input.json);
    if (!parsed.success) {
      throw new FormatParseError(
        parsed.error.issues[0]?.message ?? "Invalid payload",
        "benchable",
      );
    }

    const metrics: Record<string, MetricValue> = {};
    for (const [key, value] of Object.entries(parsed.data.metrics)) {
      metrics[key] = typeof value === "number" ? { value } : value;
    }

    return {
      format: "benchable",
      metrics,
      spans: parsed.data.spans,
      metadata: parsed.data.metadata,
      label: parsed.data.label,
      startedAt: parsed.data.startedAt,
      branch: parsed.data.branch,
      commitSha: parsed.data.commitSha,
      environment: parsed.data.environment,
      idempotencyKey: parsed.data.idempotencyKey,
    };
  },
};
