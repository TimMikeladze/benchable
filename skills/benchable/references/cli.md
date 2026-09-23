# CLI reference

`node scripts/benchable.mjs <command>`: one file, Node 18+, no dependencies. It is the same
CLI as `npx benchable` (the `benchable` package, github.com/TimMikeladze/benchable).

## Agent commands

| Command | What it does |
| --- | --- |
| `status [--json]` | Prints the mode (`cloud`, `local` or `unconfigured`) and where each setting came from. |
| `login [--url <server>] [--client claude-code\|codex\|opencode\|cli] [--no-wait] [--no-browser] [--timeout <s>]` | Device-code login. It opens the browser, the user approves one project, and a project API key is saved. `--no-wait` prints the URL and exits, and the next `login` resumes the same request. |
| `record --file <f\|-> [--label] [--format auto] [--artifact <path>]... [--kind <k>] [--baseline <stem>] [--branch] [--commit] [--env] [--local] [--json]` | Records a run in the active mode. It falls back to local when the server can't be reached. Branch and commit come from git unless you give them. |
| `comment --run <id\|last> --body <text> [--metric <key>]` | Comments on a cloud run. Start automated conclusions with "Automated analysis:". |
| `mcp --agent claude-code\|codex\|opencode` | Prints the MCP config for the resolved server. |
| `key` | Prints the resolved key, only so you can run `export BENCHABLE_KEY=$(… key)` before wiring MCP. |
| `local init` | Chooses local mode (writes `{"mode":"local"}` to `.benchable/config.json`). |
| `local report` | Regenerates `.benchable/report.html` and prints its path. |
| `local sync` | Uploads every local run and artifact to the connected project. Safe to repeat. |

## Cloud commands

`submit`, `import`, `upload`, `artifacts`, `download`, `summary`, `report`, `regressions` and
`formats` work as documented in the package README. `--run last` means the newest run.

## Configuration

For each field, the first source that has a value wins:

| field | env | `.benchable/config.json` (committable) | `~/.config/benchable/credentials.json` (0600) |
| --- | --- | --- | --- |
| url | `BENCHABLE_URL` | `url` | the only URL stored |
| key | `BENCHABLE_KEY` | `key` (warned) | `[url].projects[project].key` |
| project | — | `project` | `[url].default` |

- `XDG_CONFIG_HOME` moves the credentials file.
- `login` defaults to `https://benchable.sh`. For a self-hosted server, pass `--url` or set
  `BENCHABLE_URL`.
- An explicit `"mode": "local"` beats stored credentials, but not env vars (so CI with secrets
  still uploads).

## Exit codes

- `0`: clean.
- `1`: a metric regressed, or a budget failed.
- `2`: error (bad input, auth, network during sync).

## Formats

`record` and `import` detect these 13 formats: `benchable` (native JSON), `go-bench`,
`hyperfine`, `pytest-benchmark`, `google-benchmark`, `criterion`, `vitest-bench`, `k6`,
`lighthouse`, `jmh`, `prometheus`, `csv` and `otlp-trace`. Run `formats` in cloud mode for how
to produce each one.

Native JSON, for a number you measured that no tool formats:

```json
{ "metrics": { "bundle.size_bytes": { "value": 184320, "unit": "bytes" }, "build.time_ms": 4210 } }
```

Direction is inferred from the key (`throughput`, `ops`, `rps`, `score`, `coverage`… mean higher
is better), or you can set `"direction": "higher"` explicitly.
