import { join } from "node:path";

/** Inlined by `scripts/build-skill.ts`. Absent when the CLI runs from source under Bun. */
declare const __BENCHABLE_REPORT_BUNDLE__: string | undefined;

/**
 * The report's chart bundle (React + TanStack Charts). The shipped CLI carries it as a
 * string; from source it is built on the fly, so `bun run benchable local report` always
 * reflects the current chart definitions.
 */
export async function loadReportBundle(): Promise<string> {
  if (typeof __BENCHABLE_REPORT_BUNDLE__ === "string") return __BENCHABLE_REPORT_BUNDLE__;
  return buildReportBundle();
}

export async function buildReportBundle(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "report-client.tsx")],
    target: "browser",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));
  return result.outputs[0]!.text();
}
