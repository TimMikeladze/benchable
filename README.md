# benchable

The client side of [Benchable](https://benchable.sh). Benchable stores benchmark results and
decides, with statistics, whether a change made something slower. This repo holds everything
that runs outside the server:

- **Agent skill** (`skills/benchable`). It teaches Claude Code, Codex and OpenCode to benchmark
  before and after a change and to read back a tested verdict.
- **CLI** (`benchable`). It records runs in the cloud or self-hosted, or offline in `.benchable/`
  with a self-contained HTML report, and syncs the local history up later.
- **SDK**: a typed, dependency-free client for the API.
- **Formats and statistics**: the 16 benchmark-output parsers (13 benchmark tools plus the
  OTLP, Jaeger, Zipkin and Chrome/Perfetto trace formats), and the Welch / Mann–Whitney
  comparison behind every verdict. The Benchable server runs this same code.

## Agent skill

```sh
npx skills add TimMikeladze/benchable --skill benchable
```

The skill ships the CLI as one Node 18+ file (`skills/benchable/scripts/benchable.mjs`), so
there is nothing else to install. On each use the agent checks which mode it is in:

- **cloud**: `BENCHABLE_URL` and `BENCHABLE_KEY` are set, or `benchable login` ran before.
  Runs land in your project, and the agent hands you the run URL.
- **unconfigured**: `benchable login` opens the browser. You approve one project, and a project
  API key is saved to `~/.config/benchable/credentials.json` (mode 0600). It is a device-code
  flow, so it works over SSH. For a self-hosted server, pass `--url https://bench.internal`.
- **local**: there's no account, or no network. Runs are saved as native JSON in
  `.benchable/runs/`, with verdicts from the same statistics. To chart them, point the app's
  local watch at that folder or run `benchable local sync`.

The loop is: baseline, change, after, verdict, link.

```sh
hyperfine -N --runs 30 -n parse --export-json /tmp/bench.json 'node parse.js big.json'
benchable record --file /tmp/bench.json --label baseline
# …change parse.js…
hyperfine -N --runs 30 -n parse --export-json /tmp/bench.json 'node parse.js big.json'
benchable record --file /tmp/bench.json --label "stream the parser" --artifact flame.svg
```

```text
metric                  value  baseline    change   verdict  test
----------------------  -----  --------  --------  --------  --------------------
hyperfine.parse.mean_ms  9.0ms    14.6ms  ▼ -38.4%  improved  mann-whitney p<0.001

view: https://benchable.sh/p/web/runs/r_8c1…
```

`benchable local sync` uploads the local history, with its artifacts. Running it twice
duplicates nothing, because every run file carries its own idempotency key.
`benchable mcp --agent claude-code|codex|opencode` prints the MCP config for each agent. The
skill's `references/` folder covers the CLI, MCP, raw HTTP, local mode, and how to explain a
verdict.

## CLI

```sh
benchable status                     # which mode, and where each setting came from
benchable login                      # connect in the browser
benchable record --file out.json     # any supported format; cloud, or local when offline
benchable comment --run last --body "Automated analysis: …"
benchable local init | sync

# cloud-only commands
benchable import  --file bench.txt --branch main --commit "$(git rev-parse HEAD)"
benchable submit  --metrics metrics.json --branch main
benchable summary
benchable report --run last --marker pr-42   # Markdown for a PR comment
benchable regressions --status live
benchable upload --run last --file flame.svg --kind flamegraph
benchable artifacts --run last
benchable download --run last --name flame.svg
benchable formats
```

Configuration is resolved per field. The first source with a value wins: env
(`BENCHABLE_URL`, `BENCHABLE_KEY`), then `.benchable/config.json` (committable, no secret),
then `~/.config/benchable/credentials.json`.

Exit codes: `0` clean, `1` a metric regressed or a budget failed, `2` an error.
`examples/github-actions.yml` is a workflow that fails a pull request on a regression.

## SDK

```ts
import { Benchable } from "benchable";

const benchable = new Benchable({ apiKey: process.env.BENCHABLE_KEY! });

const result = await benchable.run({
  branch: "main",
  commitSha: process.env.GITHUB_SHA,
  metrics: { "api.latency_ms": { value: 118.4, p95: 180, p99: 260 } },
});

if (result.regressions > 0) process.exit(1);
```

A non-2xx response throws `BenchableError`, which carries `status` and the parsed body.
`benchable.import(format, body)` posts a tool's raw output instead of the native payload.
`src/index.ts` imports nothing, so you can vendor that one file on its own.

## Formats

| `format` | Produce it with |
|---|---|
| `benchable` | The native JSON payload |
| `go-bench` | `go test -bench=. -benchmem -count 10 ./...` |
| `hyperfine` | `hyperfine --export-json bench.json -n build './build.sh'` |
| `pytest-benchmark` | `pytest --benchmark-json=bench.json` |
| `google-benchmark` | `./bench --benchmark_format=json --benchmark_repetitions=5` |
| `criterion` | `cargo criterion --message-format=json` |
| `vitest-bench` | `vitest bench --outputJson=bench.json` |
| `k6` | `k6 run --summary-export=summary.json script.js` |
| `lighthouse` | `lighthouse https://example.com --output=json` |
| `jmh` | `java -jar benchmarks.jar -rf json -rff bench.json` |
| `prometheus` | `curl -s http://localhost:9090/metrics` |
| `csv` | `name,value[,unit[,lower\|higher]]` |
| `otlp-trace` | OTLP/JSON `ResourceSpans` — spans, trace ids, service names |
| `jaeger` | Jaeger JSON export — spans, trace ids, services from processes |
| `zipkin` | Zipkin v2 JSON — spans, trace ids, services from endpoints |
| `chrome-trace` | Chrome DevTools / Perfetto trace-events JSON — one waterfall |

Detection is automatic. Where the tool reports raw samples (hyperfine's `times`, go-bench under
`-count`, criterion), they are kept, so a comparison can use Mann–Whitney U instead of Welch's t.

## As a library

| Import | What |
|---|---|
| `benchable` | The SDK |
| `benchable/formats` | `parseRaw`, `detectFormat` and the adapters |
| `benchable/schema` | The zod ingest schema (`runPayloadSchema`) and unit/direction inference |
| `benchable/comparison` | `classify()`: noise band, then Mann–Whitney or Welch |
| `benchable/statistics` | The tests, quantiles, Benjamini–Hochberg |
| `benchable/format` | Value, duration and percent formatting |
| `benchable/cli` | Config resolution, login, local runs, sync and the report, as functions |

The entry points ship as TypeScript source. They work directly under Bun, Deno, and bundlers
that resolve `.ts` (for Next.js, add `transpilePackages: ["benchable"]`).

## Development

```sh
bun install
bun test
bun run typecheck
bun run skill:build   # rebuilds skills/benchable/scripts/benchable.mjs; CI fails if it is stale
```

Design notes are in [`docs/design.md`](docs/design.md). The Benchable server consumes this repo
as a git subtree, so a change here reaches the server on its next `git subtree pull`.

## License

MIT
