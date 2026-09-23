# MCP

The Benchable MCP server is at `<url>/api/mcp`, over streamable HTTP. It takes the project API
key as a bearer token. `node scripts/benchable.mjs mcp --agent <agent>` prints the config below
filled in with the resolved URL. The key is always read from `BENCHABLE_KEY` and never inlined.
After `benchable login`, export it first:

```bash
export BENCHABLE_KEY=$(node scripts/benchable.mjs key)
```

Don't echo the key into the conversation. Use it only inside the shell command.

## Claude Code

```bash
claude mcp add --transport http benchable https://benchable.sh/api/mcp --header "Authorization: Bearer $BENCHABLE_KEY"
```

Add `--scope user` to make it available in every project.

## Codex

```bash
codex mcp add benchable --url https://benchable.sh/api/mcp --bearer-token-env-var BENCHABLE_KEY
```

The equivalent in `~/.codex/config.toml`:

```toml
[mcp_servers.benchable]
url = "https://benchable.sh/api/mcp"
bearer_token_env_var = "BENCHABLE_KEY"
```

## OpenCode

In `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "benchable": {
      "type": "remote",
      "url": "https://benchable.sh/api/mcp",
      "headers": { "Authorization": "Bearer {env:BENCHABLE_KEY}" }
    }
  }
}
```

## Tools (18)

Every tool answers in plain text. The key scopes every tool to one project.

| Tool | Use it to |
| --- | --- |
| `project_summary` | Start here: see what is tracked and its health. |
| `project_report` | Get a digest over a window. |
| `list_metrics` | List metric keys with unit, direction and noise band. |
| `get_metric_series` | Get one metric's history. |
| `detect_change_points` | Answer "why is it slower than it used to be": finds steps and drift, with the commit range. |
| `list_regressions` / `triage_regression` | Read the regression queue, and set a status. |
| `list_runs` / `get_run` | Read recent runs and one run's detail. |
| `compare_runs` | Compare two specific runs, metric by metric, with significance. |
| `list_artifacts` | See what is attached to a run. |
| `list_branches` | List branches that have runs. |
| `submit_run` | Record measurements (native metrics object). Pass `idempotencyKey` on retries. |
| `import_run` | Record a tool's raw output (the same 13 formats). |
| `list_comments` / `post_comment` / `resolve_comment` | Read the discussion before adding to it. Comments are shown as automated. |
| `explain_regression` | Get an AI diagnosis of a bad run (when the server has AI enabled). |

Artifacts can't be uploaded over MCP. Use `record --artifact` or `upload`.
