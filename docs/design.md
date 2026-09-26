# Design: the agent skill and CLI

A coding agent that benchmarks something (a refactor, a bundle-size change, prompt latency) should
record each measurement as a Benchable run, get a verdict back with statistics, and hand the user
a link to a chart. With no account and no network it should still work, on the filesystem, and
the history it builds there should move into the cloud later with nothing lost and nothing
duplicated.

## Decisions

- **One skill, installed by skills.sh.** `skills/benchable/SKILL.md` in this repo. `npx skills
  add <owner>/<repo> --skill benchable` discovers it under `skills/` and links it into every
  detected agent: Claude Code at `.claude/skills/`, and Codex and OpenCode at `.agents/skills/`.
  The frontmatter has only `name` and `description`, the two fields every agent reads. There are
  no agent-specific fields.
- **The skill ships its own CLI.** `skills/benchable/scripts/benchable.mjs` is `src/cli/benchable.ts`
  bundled by `bun run skill:build` into one Node 18+ file with no dependencies. The report's
  chart bundle (React + TanStack Charts) is inlined. Agents run `node <skill>/scripts/benchable.mjs
  …`, so the skill needs nothing from npm and the version it documents is the one it runs. The
  same file is the `benchable` package's `bin`.
  The bundle is committed, and CI rebuilds it and fails on a diff.
- **Logic lives in the CLI, not in SKILL.md.** The skill decides nothing that a command could:
  `status` reports the mode, `record` records in whichever mode is active, `local sync` handles
  the rest. SKILL.md teaches the loop. Long material goes in
  `references/*.md`, loaded on demand.
- **The agent never builds JSON by hand.** `record --file` takes any of the 13 formats that
  `src/formats` detects (hyperfine, go-bench, vitest-bench, …). The same parser runs locally, so
  local mode and cloud mode agree on what a file contains.

## Modes and how they are detected

`benchable status` prints the mode and where each setting came from (`--json` for machines).
It checks in this order:

1. **cloud**: a URL and a key both resolve. Includes self-hosted, which is just another URL.
2. **local**: `.benchable/config.json` says `"mode": "local"`, meaning the user declined an
   account. It is also used for the run when `record` fails to reach a configured server; the
   output says `offline, recorded locally` and suggests `local sync`.
3. **unconfigured**: neither of the above. The skill offers `benchable login` (one click), and
   if the user declines, runs `benchable local init`, which writes `"mode": "local"`.

Config resolution. The first source that has a value wins, per field:

| field   | 1. env           | 2. project `.benchable/config.json` | 3. user `~/.config/benchable/credentials.json` |
| ------- | ---------------- | ----------------------------------- | --------------------------------------------- |
| url     | `BENCHABLE_URL`  | `url`                               | the only url stored, if there is exactly one  |
| key     | `BENCHABLE_KEY`  | `key` (discouraged, warned)         | `[url].projects[project].key`, else `[url].default` |
| project | —                | `project` (slug)                    | `[url].default`                               |

The project file is found by walking up from the current directory to the git root. It holds
no secret by default, so it can be committed. The credentials file is written with mode 0600,
and `XDG_CONFIG_HOME` is honoured. `login` defaults to `https://benchable.sh`; `--url` or
`BENCHABLE_URL` points it at a self-hosted server.

Cloud transport: use MCP when the agent has the `benchable` server configured, and the CLI
otherwise. HTTP (curl) is the last resort. `benchable mcp --agent claude-code|codex|opencode`
prints the config for the resolved URL. The key is passed through an env var and never inlined.

## Connect flow (`benchable login`)

A device-code flow, so it works from a terminal an agent drives, over SSH, and in containers.

1. `POST /api/v1/connect` with `{ client }`, unauthenticated and rate limited per IP. It returns
   `{ deviceCode, userCode, verificationUrl, expiresIn: 600, interval: 2 }`. `client` is one
   of `claude-code | codex | opencode | cli | other`. Nothing else is sent: no hostname,
   username or email.
2. The CLI prints the URL and the code and opens the browser (skipped with `--no-browser`).
   `verificationUrl` is `/connect?code=ABCD-EFGH`. A signed-out visitor goes to
   `/sign-in?next=…` and comes back.
3. `/connect` shows the code and the client, with a warning to approve only a request started
   from their own terminal. The user picks a project from their active workspace and chooses
   **Approve** or **Deny**. Approving checks project write access and the `apiKeysPerProject`
   limit.
4. The CLI polls `POST /api/v1/connect/token` with `{ deviceCode }` and gets back
   `pending | denied | expired`, or `approved` with `{ key, url, project: { slug, name } }`.
   **The key is minted at the poll, not at approval**: an atomic `UPDATE … WHERE
   status='approved' RETURNING` claims the request, a new `api_key` row is inserted, and the
   plaintext exists only in that one response. A second poll sees `consumed`.
5. The CLI writes the key to the credentials file, writes `{ url, project }` to
   `.benchable/config.json`, and prints the project URL.

The name of the minted key is `Agent login (<client>)`, so it appears in the project's key list
and can be revoked like any other key.

`login --no-wait` starts the flow, saves the pending device code next to the credentials
(`~/.config/benchable/pending-login.json`, 0600, never in the repo), prints the URL and exits.
The next `login` resumes it. The skill uses this so it doesn't block on a 10-minute poll.

## Local mode: file layout

```
.benchable/
  config.json                        { "mode": "local" } or { "url", "project" }
  runs/20260923T101500Z-baseline.json   native payload (+ idempotencyKey, artifacts)
  artifacts/20260923T101500Z-baseline/flame.svg
  sync.json                          { "<url>#<project>": { "<idempotencyKey>": "<runId>" } }
```

- A run file is the native payload that `POST /api/v1/runs` accepts, plus two extra fields:
  `idempotencyKey` (`local:<stem>-<8 random hex>`, fixed at record time) and `artifacts`
  (`[{ path, name, kind, bytes, sha256 }]`, relative to `.benchable/`). The server's schema
  strips `artifacts`. `environment` defaults to `local`, and branch and commit come from git
  when available.
- Run files are written once and never rewritten. Sync state lives in `sync.json` so that a
  watched folder never sees a run file change.
- Artifacts live outside `runs/`, so local watch pointed at `.benchable/runs/` never mistakes a
  `trace.json` for a run.

**Verdicts locally.** The baseline is the latest earlier run on the same branch, else the
latest earlier run, else none (`first run`). `--baseline <stem>` overrides it. Each metric goes
through the same `classify()` the server uses: the direction is the payload's or inferred from
the key, and the band is 5%. That means Mann–Whitney when both runs carry sample vectors (for
example hyperfine's `times`) and Welch's t on `{mean, stddev, n}` otherwise. There is no noise
band learned from history and no false-discovery control, and the CLI output says so.

**No local report.** Local mode prints the verdict and writes run JSON, nothing else. Charts
live in the app: `local sync` uploads the history, or local watch reads `.benchable/runs/`
directly. That keeps the CLI free of React and chart dependencies.

## Sync semantics

`benchable local sync` needs cloud config. For each run file, oldest `startedAt` first:

1. `POST /api/v1/runs` with the file's payload. The body's `idempotencyKey` makes a re-send
   return the existing run with `idempotent: true`.
2. For each artifact, list the run's artifacts and upload only when no artifact matches the
   name and sha256. Re-running uploads nothing.
3. Record `idempotencyKey → runId` in `sync.json`, and add cloud links to the report.

Local watch on `.benchable/runs/` sends the same files through `importRaw`, which now uses the
embedded key. So syncing, watching, and doing both in either order all produce one run per
file. Local watch does not carry artifacts, so `local sync` is the lossless path.

## Where it lives

- `src/cli/benchable.ts`: command dispatch. `src/cli/api.ts` exports the pieces as a library.
- `src/cli/config.ts`: config resolution and mode detection. Pure: env, cwd and home are injected.
- `src/cli/login.ts`: the device-flow client. The server side (`/api/v1/connect`, the `/connect`
  approval page) lives in the Benchable app.
- `src/cli/local/store.ts` (record, baselines, verdicts), and `sync.ts`.
- `src/formats`, `src/schema.ts`, `src/comparison.ts`, `src/statistics.ts`: shared with the
  server, which imports them from this package.
- `scripts/build-skill.ts`: builds the skill's `benchable.mjs`.

## Tests

`tests/agent-config.test.ts` covers mode detection and config precedence.
`tests/local-mode.test.ts` covers the writer, baselines, verdicts, artifacts and report
escaping. `tests/formats.test.ts`, `statistics.test.ts` and `comparison.test.ts` cover the
shared core. The login flow and sync against a real database are integration-tested in the
Benchable app, through `benchable/cli`.
