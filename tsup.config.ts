import { defineConfig } from "tsup";

// Builds the published library into dist/: ESM + CommonJS + bundled .d.ts per entrypoint,
// so the package works under Node (import or require), Bun, Deno and bundlers alike.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    formats: "src/formats/index.ts",
    statistics: "src/statistics.ts",
    comparison: "src/comparison.ts",
    schema: "src/schema.ts",
    format: "src/format.ts",
    cli: "src/cli/api.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  target: "node18",
  platform: "node",
  clean: true,
});
