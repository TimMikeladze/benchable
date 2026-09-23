---
name: benchable
description: Record benchmark results as Benchable runs and get a statistical verdict (regressed, improved or unchanged) with a chart link. Use it whenever you measure performance before and after a change (a refactor, a perf fix, bundle size, build time, prompt latency, hyperfine, go test -bench, vitest bench, pytest-benchmark, criterion, k6, Lighthouse), or when the user asks "did this make it slower?". It works in Benchable cloud or self-hosted, and offline on the filesystem with a self-contained HTML report.
---

# Benchable

Benchable stores what you measure and tells you whether it changed, with statistics (Mann–Whitney
U on raw samples, Welch's t on mean, stddev and n). This skill ships its own CLI:

```bash
BENCHABLE="node <this skill's directory>/scripts/benchable.mjs"   # Node 18+, no install
```

Use the path of the directory that holds this SKILL.md, for example
`.claude/skills/benchable/scripts/benchable.mjs` or `.agents/skills/benchable/scripts/benchable.mjs`.

## Rules

- **Never fabricate numbers.** Record only output that a tool you ran actually produced. Never
  hand-write metrics JSON for something you did not measure.
- **Wrap the tool's own output.** Run hyperfine, `go test -bench` or vitest bench and pass the
  file to `record`. The format is detected, and 13 formats are supported (`$BENCHABLE formats`).
- **Don't eyeball numbers.** The verdict comes from `record`, `compare_runs` or
  `detect_change_points`. Report what it says, including "not significant".
- **Keep metric names stable across runs**, or there is no baseline to compare with. For
  hyperfine, always pass `-n <name>`, because the command text is part of the metric key.
- **Show the user every time.** Give them the run URL (cloud) or the `report.html` path (local).

## 1. Detect the mode and tell the user

```bash
$BENCHABLE status
```

- `mode: cloud`: a URL and key resolved (from env, `.benchable/config.json`, or an earlier login).
  Results become runs in their project. If the `benchable` MCP server is configured, you may use
  its tools. Otherwise use the CLI.
- `mode: local`: the user chose not to use an account. Runs go to `.benchable/runs/`, and you
  get the report at `.benchable/report.html`.
- `mode: unconfigured`: ask the user once: "Connect Benchable to chart these results? One click
  in the browser." Then do one of these:
  - If they say yes: `$BENCHABLE login --client <claude-code|codex|opencode> --no-wait`. It opens
    the browser and prints a URL and code. Give both to the user. After they approve, run
    `$BENCHABLE login` again (with a long timeout), which finishes and saves the key.
  - If they say no, or there's no network: `$BENCHABLE local init`.

Say which mode is active in one line before you record anything.

## 2. The loop

1. **Baseline, before touching code.** Run the benchmark and `record --label baseline`.
2. **Make the change.**
3. **After.** Run the same benchmark the same way, then `record --label <what changed>`.
4. **Read the verdict and explain it.** Say which metrics moved, by how much (±%), and the
   confidence (the `signal`/`test` column: Mann–Whitney or Welch p-value). If there was no test, say the move only cleared the ±5% noise
   band. Exit code: 0 clean, 1 regression, 2 error.
5. **Attach evidence**: `--artifact profile.cpuprofile --artifact flame.svg`.
6. **Hand over the link**: the `view:` URL in cloud mode, or the `report:` path locally.
7. **Cloud only:** post your conclusion as a comment on the run, starting with "Automated
   analysis:": `$BENCHABLE comment --run <runId|last> --body "Automated analysis: …"`, or MCP
   `post_comment`. If the user wants to send the result to someone else, a `share:`
   URL is printed when the project is already shared. Otherwise, tell them to enable sharing in
   project settings.

When `record` can't reach the server, it saves the run locally and says so. Later, run
`$BENCHABLE local sync` to upload everything, with no duplicates.

## Worked examples

**hyperfine**

```bash
hyperfine -N --warmup 3 --runs 30 -n parse --export-json /tmp/bench.json 'node parse.js big.json'
$BENCHABLE record --file /tmp/bench.json --label baseline
# ...change parse.js...
hyperfine -N --warmup 3 --runs 30 -n parse --export-json /tmp/bench.json 'node parse.js big.json'
$BENCHABLE record --file /tmp/bench.json --label "stream the parser"
```

hyperfine's `times` travel with the run, so the verdict uses Mann–Whitney: `hyperfine.parse.mean_ms
▼ -38.2% improved mann-whitney p<0.001`.

**go test -bench**: use `-count` so each benchmark has a distribution.

```bash
go test -run '^$' -bench . -benchmem -count 10 ./pkg/parser > /tmp/bench.txt
$BENCHABLE record --file /tmp/bench.txt --label baseline
```

**vitest bench**

```bash
npx vitest bench --run --outputJson /tmp/bench.json
$BENCHABLE record --file /tmp/bench.json --label baseline
```

## Answering "did my change make it slower?"

- Two specific runs: MCP `compare_runs`. Via the CLI, the verdict from `record` already is that
  comparison.
- A slow drift over many runs: MCP `detect_change_points`. Don't compare two runs by hand.
- One bad run: MCP `explain_regression` (cloud, if AI is enabled), then `get_run`.

## References (load when needed)

- `references/cli.md`: every command, flag, config file and exit code.
- `references/mcp.md`: MCP setup for Claude Code, Codex and OpenCode, and the 18 tools.
- `references/http.md`: the raw HTTP API, for agents with no Node and no MCP.
- `references/local-mode.md`: the `.benchable/` layout, report.html, and sync semantics.
- `references/verdicts.md`: how to read and explain a verdict honestly.
