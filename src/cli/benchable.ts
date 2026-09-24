#!/usr/bin/env bun
/**
 * Benchable CLI.
 *
 *   benchable submit  --metrics metrics.json [--branch main] [--commit $SHA]
 *   benchable import  --file bench.txt [--format auto]
 *   benchable upload  --run last --file flame.svg [--kind flamegraph]
 *   benchable artifacts --run last
 *   benchable download --run last --name flame.svg [--out flame.svg]
 *   benchable summary
 *   benchable report  --run <id> [--marker <id>] [--full]
 *   benchable regressions [--status live]
 *   benchable formats
 *
 * Agent skill commands (docs/design.md):
 *
 *   benchable status [--json]                   which mode is active, and why
 *   benchable login [--url] [--client] [--no-wait] [--no-browser]
 *   benchable record --file out.json [--label] [--artifact f]...   cloud, or local when offline
 *   benchable comment --run last --body "Automated analysis: …"
 *   benchable mcp --agent claude-code|codex|opencode
 *   benchable local init|report|sync
 *
 * Reads BENCHABLE_URL and BENCHABLE_KEY, then `.benchable/config.json`, then the credentials
 * `benchable login` saved. Exits 1 when a run regressed, which is the whole reason to have it
 * in CI rather than a bare curl.
 */
import { basename, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

import { FormatParseError, isFormatId, type FormatId } from "../formats";

import { benchableDir, DEFAULT_URL, maskKey, readProjectConfig, resolveConfig, writeProjectConfig, type ResolvedConfig } from "./config";
import { gitInfo } from "./git";
import { LOGIN_CLIENTS, login } from "./login";
import { loadReportBundle } from "./local/bundle";
import { formatLocalVerdict } from "./local/format";
import { renderReport } from "./local/report";
import { buildReportData } from "./local/report-data";
import { listLocalRuns, recordLocal, verdictHistory, type RecordResult } from "./local/store";
import { cloudUrls, syncLocal } from "./local/sync";
import { MCP_AGENTS, mcpSnippet, type McpAgent } from "./mcp-config";

interface Options {
  [key: string]: string | boolean | string[];
}

/** Flags that may repeat; each occurrence is collected. */
const REPEATABLE = new Set(["artifact"]);

/**
 * Files larger than this request an upload grant and PUT to Blob instead of a request body —
 * serverless platforms cap request bodies near here regardless of the server's own import
 * limit. Mirrors DIRECT_IMPORT_MAX_BYTES in the app.
 */
const IMPORT_GRANT_THRESHOLD = 4 * 1024 * 1024;

export function parseArgs(argv: string[]): { command: string; positionals: string[]; options: Options } {
  const [command = "help", ...rest] = argv;
  const options: Options = {};
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = rest[i + 1];
    let value: string | true = true;
    if (next !== undefined && !next.startsWith("--")) {
      value = next;
      i += 1;
    }
    if (REPEATABLE.has(key) && typeof value === "string") {
      const list = options[key];
      options[key] = Array.isArray(list) ? [...list, value] : [value];
    } else options[key] = value;
  }
  return { command, positionals, options };
}

function where() {
  return { env: process.env, cwd: process.cwd(), home: homedir() };
}

function requireEnv(): { url: string; key: string } {
  const config = resolveConfig(where());
  if (!config.url || !config.key) {
    fail("Not connected. Run `benchable login`, or set BENCHABLE_URL and BENCHABLE_KEY.");
  }
  return { url: config.url, key: config.key };
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function readInput(options: Options, flag: string): string {
  const path = options[flag];
  if (typeof path === "string" && path !== "-") return readFileSync(path, "utf8");
  // No path, or `-`: read stdin, so the CLI composes with a pipe.
  return readFileSync(0, "utf8");
}

async function request(
  path: string,
  init: RequestInit & { key: string; url: string },
): Promise<{
  status: number;
  body: string;
  regressions: number | null;
  budgetFailures: number | null;
  runId: string | null;
}> {
  const response = await fetch(`${init.url}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${init.key}`,
      accept: "text/plain",
      ...(init.headers ?? {}),
    },
  });
  const header = response.headers.get("x-benchable-regressions");
  const budgetHeader = response.headers.get("x-benchable-budget-failures");
  return {
    status: response.status,
    body: await response.text(),
    regressions: header === null ? null : Number(header),
    budgetFailures: budgetHeader === null ? null : Number(budgetHeader),
    runId: response.headers.get("x-benchable-run-id"),
  };
}

/**
 * Attach one artifact to a run, direct or — above the request-body threshold — via an upload
 * grant: mint, PUT to Blob, adopt by reference. Same fallback rules as `record`'s import
 * path (docs/large-uploads.md).
 */
async function attachArtifact(
  url: string,
  key: string,
  runId: string,
  path: string,
  name: string,
  kind?: string,
): Promise<{ status: number; body: string }> {
  const query = new URLSearchParams({ name });
  if (kind) query.set("kind", kind);

  // Read as bytes, not text: a flamegraph is usually SVG but a heap snapshot is not.
  const bytes = readFileSync(path);
  if (bytes.byteLength <= IMPORT_GRANT_THRESHOLD) {
    return request(`/api/v1/runs/${encodeURIComponent(runId)}/artifacts?${query.toString()}`, {
      url,
      key,
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });
  }

  const grantResponse = await request(`/api/v1/runs/${encodeURIComponent(runId)}/artifacts/upload-url`, {
    url,
    key,
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ name, ...(kind ? { kind } : {}) }),
  });
  // Older servers, or no Blob configured: fall back to the direct body and let its error
  // explain the limit.
  if (grantResponse.status === 404 || grantResponse.status === 503) {
    return request(`/api/v1/runs/${encodeURIComponent(runId)}/artifacts?${query.toString()}`, {
      url,
      key,
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });
  }
  if (grantResponse.status >= 400) return grantResponse;

  const grant = JSON.parse(grantResponse.body) as {
    token: string;
    pathname: string;
    access: "private";
    artifactId: string;
  };
  const { put } = await import("@vercel/blob/client");
  const uploaded = await put(grant.pathname, bytes, {
    access: grant.access,
    token: grant.token,
    contentType: "application/octet-stream",
  });

  return request(`/api/v1/runs/${encodeURIComponent(runId)}/artifacts?${query.toString()}`, {
    url,
    key,
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/plain" },
    body: JSON.stringify({ url: uploaded.url, artifactId: grant.artifactId }),
  });
}

function commonQuery(options: Options): string {
  const params = new URLSearchParams();
  for (const [flag, param] of [
    ["branch", "branch"],
    ["commit", "commitSha"],
    ["env", "environment"],
    ["label", "label"],
    ["format", "format"],
    ["idempotency-key", "idempotencyKey"],
  ] as const) {
    const value = options[flag];
    if (typeof value === "string") params.set(param, value);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

/**
 * `--run last` saves CI from threading the run id through two steps: submit, then act on
 * whatever landed most recently. Every command that takes a run accepts it.
 */
async function resolveRun(options: Options, url: string, key: string): Promise<string> {
  const requested = typeof options.run === "string" ? options.run : "last";
  if (requested !== "last") return requested;

  const { status, body } = await request("/api/v1/runs?limit=1", {
    url,
    key,
    headers: { accept: "application/json" },
  });
  if (status >= 400) fail(body);
  const parsed = JSON.parse(body) as { runs: Array<{ id: string }> };
  if (!parsed.runs?.[0]) fail("This project has no runs yet.");
  return parsed.runs[0].id;
}

/**
 * The body is the human-readable digest; the exit code comes from the
 * `x-benchable-regressions` and `x-benchable-budget-failures` headers, so CI gates on a
 * number rather than on prose. Either failing exits 1: a build that is over budget is broken
 * even when nothing regressed since yesterday.
 */
function report(result: {
  status: number;
  body: string;
  regressions: number | null;
  budgetFailures: number | null;
}): never {
  process.stdout.write(result.body.endsWith("\n") ? result.body : `${result.body}\n`);
  if (result.status >= 400) process.exit(2);
  process.exit((result.regressions ?? 0) > 0 || (result.budgetFailures ?? 0) > 0 ? 1 : 0);
}

function str(options: Options, flag: string): string | undefined {
  const value = options[flag];
  return typeof value === "string" ? value : undefined;
}

async function writeReport(config: ResolvedConfig): Promise<string> {
  const runs = listLocalRuns(config.root);
  const target = config.url ? { url: config.url, project: config.project } : null;
  const data = buildReportData(basename(config.root), verdictHistory(runs), {
    cloudUrls: cloudUrls(config.root, target),
  });
  const path = join(benchableDir(config.root), "report.html");
  writeFileSync(path, renderReport(data, await loadReportBundle()));
  return path;
}

function describeMode(config: ResolvedConfig): string {
  if (config.mode === "cloud") {
    return [
      `mode: cloud`,
      `url: ${config.url} (from ${config.sources.url})`,
      `project: ${config.project ?? "(the key's project)"}${config.sources.project ? ` (from ${config.sources.project})` : ""}`,
      `key: ${maskKey(config.key!)} (from ${config.sources.key})`,
    ].join("\n");
  }
  if (config.mode === "local") {
    return `mode: local\nruns: ${relative(process.cwd(), join(benchableDir(config.root), "runs")) || "."}\nreport: ${join(benchableDir(config.root), "report.html")}`;
  }
  return [
    "mode: unconfigured",
    "Connect in one step with `benchable login`, or stay offline with `benchable local init`.",
  ].join("\n");
}

function recordOptions(options: Options, config: ResolvedConfig, raw: string) {
  const format = str(options, "format") ?? "auto";
  if (format !== "auto" && !isFormatId(format)) fail(`Unknown format "${format}". Run \`benchable formats\`.`);
  const git = gitInfo(config.root);
  const artifacts = (Array.isArray(options.artifact) ? options.artifact : []).map((path) => ({
    path,
    kind: str(options, "kind"),
  }));
  return {
    root: config.root,
    raw,
    format: format as FormatId | "auto",
    label: str(options, "label"),
    branch: str(options, "branch") ?? git.branch,
    commitSha: str(options, "commit") ?? git.commitSha,
    environment: str(options, "env"),
    artifacts,
    baseline: str(options, "baseline"),
  };
}

async function recordLocally(
  options: Options,
  config: ResolvedConfig,
  raw: string,
  why: string,
): Promise<never> {
  let result: RecordResult;
  try {
    result = recordLocal(recordOptions(options, config, raw));
  } catch (error) {
    fail(error instanceof FormatParseError || error instanceof Error ? error.message : String(error));
  }
  const report = await writeReport(config);
  if (options.json === true) {
    process.stdout.write(
      `${JSON.stringify({ mode: "local", why, file: result.file, stem: result.stem, format: result.format, report, verdict: result.verdict }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(
      [
        `run ${result.stem} (${result.format}, ${Object.keys(result.run.metrics).length} metrics), recorded locally: ${why}`,
        formatLocalVerdict(result.verdict),
        "",
        `file: ${result.file}`,
        `report: ${report}`,
        ...(result.run.artifacts.length ? [`artifacts: ${result.run.artifacts.map((a) => a.path).join(", ")}`] : []),
        "",
      ].join("\n"),
    );
  }
  process.exit(result.verdict.regressions > 0 ? 1 : 0);
}

async function main() {
  const { command, positionals, options } = parseArgs(process.argv.slice(2));

  if (command === "status") {
    const config = resolveConfig(where());
    if (options.json === true) {
      process.stdout.write(
        `${JSON.stringify(
          {
            mode: config.mode,
            root: config.root,
            url: config.url,
            project: config.project,
            key: config.key ? maskKey(config.key) : null,
            sources: config.sources,
            warnings: config.warnings,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      process.stdout.write(`${describeMode(config)}\n${config.warnings.map((w) => `warning: ${w}\n`).join("")}`);
    }
    process.exit(0);
  }

  if (command === "login") {
    const config = resolveConfig(where());
    const url = str(options, "url") ?? process.env.BENCHABLE_URL ?? readProjectConfig(config.root).url ?? DEFAULT_URL;
    const client = str(options, "client") ?? process.env.BENCHABLE_CLIENT ?? "cli";
    if (!(LOGIN_CLIENTS as readonly string[]).includes(client)) {
      fail(`--client must be one of ${LOGIN_CLIENTS.join(", ")}.`);
    }
    let result;
    try {
      result = await login({
        url,
        client,
        root: config.root,
        where: where(),
        wait: options["no-wait"] !== true,
        browser: options["no-browser"] !== true,
        timeoutSeconds: str(options, "timeout") ? Number(str(options, "timeout")) : undefined,
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    if (result.status === "approved") {
      process.stdout.write(
        `Connected to ${result.project.name}: ${result.project.url}\nKey saved to ${result.credentials}\nProject saved to .benchable/config.json\n`,
      );
      process.exit(0);
    }
    if (result.status === "started") {
      process.stdout.write(
        `Waiting for approval at ${result.verificationUrl} (code ${result.userCode}).\nRun \`benchable login\` again after approving to finish.\n`,
      );
      process.exit(0);
    }
    fail(`Login ${result.status}.`);
  }

  if (command === "key") {
    // For `export BENCHABLE_KEY=$(benchable key)` before wiring MCP. Prints only the key.
    const config = resolveConfig(where());
    if (!config.key) fail("No key. Run `benchable login` first.");
    process.stdout.write(`${config.key}\n`);
    process.exit(0);
  }

  if (command === "mcp") {
    const agent = str(options, "agent") ?? "claude-code";
    if (!(MCP_AGENTS as readonly string[]).includes(agent)) fail(`--agent must be one of ${MCP_AGENTS.join(", ")}.`);
    const config = resolveConfig(where());
    process.stdout.write(`${mcpSnippet(agent as McpAgent, config.url ?? DEFAULT_URL)}\n`);
    process.exit(0);
  }

  if (command === "local") {
    const config = resolveConfig(where());
    const sub = positionals[0] ?? "report";
    if (sub === "init") {
      const { url: _url, project: _project, key: _key, ...rest } = readProjectConfig(config.root);
      writeProjectConfig(config.root, { ...rest, mode: "local" });
      process.stdout.write(`Local mode. Runs go to ${join(benchableDir(config.root), "runs")}.\n`);
      process.exit(0);
    }
    if (sub === "report") {
      const path = await writeReport(config);
      process.stdout.write(`${path}\n`);
      process.exit(0);
    }
    if (sub === "sync") {
      if (!config.url || !config.key) fail("Nothing to sync to. Run `benchable login` first.");
      const outcomes = await syncLocal(
        config.root,
        { url: config.url, key: config.key, project: config.project },
        {
          onProgress: (o) =>
            process.stdout.write(
              o.error
                ? `✗ ${o.stem}: ${o.error}\n`
                : `${o.idempotent ? "=" : "+"} ${o.stem} → ${o.url ?? o.runId}${o.artifactsUploaded ? ` (+${o.artifactsUploaded} artifacts)` : ""}\n`,
            ),
        },
      );
      await writeReport(config);
      const failed = outcomes.filter((o) => o.error).length;
      const created = outcomes.filter((o) => !o.error && !o.idempotent).length;
      process.stdout.write(
        `${outcomes.length} local runs: ${created} uploaded, ${outcomes.length - created - failed} already synced, ${failed} failed.\n`,
      );
      process.exit(failed > 0 ? 2 : 0);
    }
    fail(`Unknown \`local ${sub}\`. Use init, report or sync.`);
  }

  if (command === "record") {
    const config = resolveConfig(where());
    const raw = readInput(options, "file");
    if (raw.trim() === "") fail("Nothing to record: the input was empty.");

    if (options.local === true || config.mode !== "cloud") {
      return await recordLocally(
        options,
        config,
        raw,
        options.local === true
          ? "--local"
          : config.mode === "local"
            ? "local mode"
            : "no account connected (run `benchable login` to use the cloud)",
      );
    }

    const url = config.url!;
    const key = config.key!;
    const input = recordOptions(options, config, raw);
    const params = new URLSearchParams();
    if (input.format !== "auto") params.set("format", input.format);
    for (const [name, value] of [
      ["label", input.label],
      ["branch", input.branch],
      ["commitSha", input.commitSha],
      ["environment", input.environment],
    ] as const) {
      if (value) params.set(name, value);
    }
    // Makes a retried record return the same run instead of a second one.
    params.set("idempotencyKey", `record:${createHash("sha256").update(raw).update(params.toString()).digest("hex").slice(0, 32)}`);

    // A file bigger than a request body may carry (serverless platforms cap bodies near 4 MB)
    // uploads straight to Blob with a server-minted grant and imports by reference. Falls
    // back to the direct body on servers without it. See docs/large-uploads.md.
    let body: string = raw;
    let contentType = "text/plain";
    if (Buffer.byteLength(raw) > IMPORT_GRANT_THRESHOLD) {
      const grantResponse = await request("/api/v1/import/upload-url", {
        url,
        key,
        method: "POST",
        headers: { accept: "application/json" },
      });
      if (grantResponse.status < 400) {
        try {
          const grant = JSON.parse(grantResponse.body) as {
            token: string;
            pathname: string;
            access: "private";
          };
          const { put } = await import("@vercel/blob/client");
          const uploaded = await put(grant.pathname, raw, {
            access: grant.access,
            token: grant.token,
            contentType: "application/json",
          });
          body = JSON.stringify({ url: uploaded.url });
          contentType = "application/json";
        } catch (error) {
          fail(`upload failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else if (grantResponse.status !== 404 && grantResponse.status !== 503) {
        process.stdout.write(
          grantResponse.body.endsWith("\n") ? grantResponse.body : `${grantResponse.body}\n`,
        );
        process.exit(2);
      }
    }

    let result;
    try {
      result = await request(`/api/v1/import?${params.toString()}`, {
        url,
        key,
        method: "POST",
        headers: { "content-type": contentType, ...(options.json === true ? { accept: "application/json" } : {}) },
        body,
      });
    } catch (error) {
      // Offline, DNS, refused: never lose a measurement. Keep it locally and say how to sync.
      return await recordLocally(
        options,
        config,
        raw,
        `offline, could not reach ${url} (${error instanceof Error ? error.message : String(error)}); run \`benchable local sync\` later`,
      );
    }
    if (result.status === 413) {
      process.stderr.write(
        "The server rejected the body size. Configure BLOB_READ_WRITE_TOKEN on it to enable large-file uploads.\n",
      );
    }
    if (result.status >= 400) {
      process.stdout.write(result.body.endsWith("\n") ? result.body : `${result.body}\n`);
      process.exit(2);
    }

    const runId = result.runId;
    for (const artifact of input.artifacts) {
      const upload = await attachArtifact(
        url,
        key,
        runId!,
        artifact.path,
        basename(artifact.path),
        artifact.kind ?? undefined,
      );
      if (upload.status >= 400) {
        process.stderr.write(`artifact ${artifact.path} failed: ${upload.body}\n`);
        process.exit(2);
      }
      if (options.json !== true) process.stdout.write(`attached ${basename(artifact.path)}\n`);
    }
    report(result);
  }

  if (command === "help" || options.help) {
    process.stdout.write(
      [
        "benchable submit  --metrics <file|-> [--branch] [--commit] [--env] [--label] [--idempotency-key]",
        "benchable import  --file <file|-> [--format auto] [--branch] [--commit] [--env]",
        "benchable upload  --run <runId|last> --file <path> [--name <n>] [--kind <k>]",
        "benchable artifacts --run <runId|last>",
        "benchable download --run <runId|last> --name <file> [--out <path|->]",
        "benchable summary",
        "benchable report  --run <runId|last> [--marker <id>] [--full]",
        "benchable regressions [--status live|open|resolved|wontfix|flaky|all]",
        "benchable formats",
        "",
        "benchable status  [--json]",
        "benchable login   [--url <server>] [--client claude-code|codex|opencode|cli] [--no-wait] [--no-browser]",
        "benchable record  --file <file|-> [--label] [--format auto] [--artifact <path>]... [--baseline <stem>] [--local] [--json]",
        "benchable comment --run <runId|last> --body <text> [--metric <key>]",
        "benchable mcp     --agent claude-code|codex|opencode",
        "benchable key     (prints the resolved key, for `export BENCHABLE_KEY=$(benchable key)`)",
        "benchable local   init | report | sync",
        "",
        "Environment: BENCHABLE_URL, BENCHABLE_KEY (else .benchable/config.json, else `benchable login`)",
        "Exit codes: 0 clean, 1 regression, 2 error",
        "",
      ].join("\n"),
    );
    process.exit(0);
  }

  const { url, key } = requireEnv();

  if (command === "formats") {
    const { status, body } = await request("/api/v1/import", { url, key, headers: { accept: "application/json" } });
    if (status >= 400) fail(body);
    const parsed = JSON.parse(body) as { formats: Array<{ id: string; description: string; produce: string }> };
    for (const format of parsed.formats) {
      process.stdout.write(`${format.id}\n  ${format.description}\n  ${format.produce}\n\n`);
    }
    process.exit(0);
  }

  if (command === "artifacts") {
    const runId = await resolveRun(options, url, key);
    const { status, body } = await request(`/api/v1/runs/${encodeURIComponent(runId)}/artifacts`, {
      url,
      key,
    });
    process.stdout.write(body);
    process.exit(status >= 400 ? 2 : 0);
  }

  if (command === "download") {
    const wanted = options.name;
    if (typeof wanted !== "string") fail("download needs --name <file>. Run `benchable artifacts` to list them.");
    const runId = await resolveRun(options, url, key);

    const listing = await request(`/api/v1/runs/${encodeURIComponent(runId)}/artifacts`, {
      url,
      key,
      headers: { accept: "application/json" },
    });
    if (listing.status >= 400) fail(listing.body);
    const parsed = JSON.parse(listing.body) as {
      artifacts: Array<{ id: string; name: string; checksum: string }>;
    };
    const match = parsed.artifacts.find((row) => row.name === wanted);
    if (!match) {
      fail(
        `No artifact named ${wanted} on run ${runId}. Attached: ` +
          (parsed.artifacts.map((row) => row.name).join(", ") || "nothing"),
      );
    }

    const response = await fetch(`${url}/api/v1/artifacts/${match.id}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!response.ok) fail(`${response.status} ${await response.text()}`);
    const bytes = Buffer.from(await response.arrayBuffer());

    // The API stores a sha256 of what it received; checking it here is the whole reason to
    // have it, and a truncated download is otherwise indistinguishable from a small file.
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== match.checksum) {
      fail(`Checksum mismatch on ${wanted}: expected ${match.checksum}, got ${actual}.`);
    }

    const out = typeof options.out === "string" ? options.out : match.name;
    if (out === "-") process.stdout.write(bytes);
    else {
      writeFileSync(out, bytes);
      process.stdout.write(`Wrote ${out} (${bytes.length} bytes, sha256 verified)\n`);
    }
    process.exit(0);
  }

  if (command === "upload") {
    const path = options.file;
    if (typeof path !== "string") fail("upload needs --file <path>.");
    const runId = await resolveRun(options, url, key);

    const { status, body } = await attachArtifact(
      url,
      key,
      runId,
      path,
      typeof options.name === "string" ? options.name : basename(path),
      typeof options.kind === "string" ? options.kind : undefined,
    );
    process.stdout.write(body);
    process.exit(status >= 400 ? 2 : 0);
  }

  if (command === "report") {
    const runId = await resolveRun(options, url, key);

    const query = new URLSearchParams();
    if (typeof options.marker === "string") query.set("marker", options.marker);
    if (options.full === true) query.set("full", "true");
    const suffix = query.size > 0 ? `?${query.toString()}` : "";

    const result = await request(`/api/v1/runs/${encodeURIComponent(runId)}/report${suffix}`, {
      url,
      key,
      headers: { accept: "text/markdown" },
    });
    report(result);
  }

  if (command === "regressions") {
    const status = typeof options.status === "string" ? options.status : "";
    const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
    const { status: code, body } = await request(`/api/v1/regressions${suffix}`, { url, key });
    process.stdout.write(body);
    process.exit(code >= 400 ? 2 : 0);
  }

  if (command === "comment") {
    const body = str(options, "body");
    if (!body) fail("comment needs --body <text>.");
    const runId = await resolveRun(options, url, key);
    const { status, body: response } = await request("/api/v1/comments", {
      url,
      key,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body, runId, ...(str(options, "metric") ? { metricKey: str(options, "metric") } : {}) }),
    });
    process.stdout.write(response.endsWith("\n") ? response : `${response}\n`);
    process.exit(status >= 400 ? 2 : 0);
  }

  if (command === "summary") {
    const { status, body } = await request("/api/v1/summary", { url, key });
    process.stdout.write(body);
    process.exit(status >= 400 ? 2 : 0);
  }

  if (command === "submit") {
    const raw = readInput(options, "metrics");
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      fail("--metrics must be a JSON file. Use `import` for a benchmark tool's own output.");
    }
    // A bare metrics object is the common case; accept it without the wrapper.
    const body =
      typeof payload === "object" && payload !== null && "metrics" in payload
        ? (payload as Record<string, unknown>)
        : { metrics: payload };

    for (const [flag, field] of [
      ["branch", "branch"],
      ["commit", "commitSha"],
      ["env", "environment"],
      ["label", "label"],
      ["idempotency-key", "idempotencyKey"],
    ] as const) {
      const value = options[flag];
      if (typeof value === "string") (body as Record<string, unknown>)[field] = value;
    }
    (body as Record<string, unknown>).source ??= "cli";

    const result = await request("/api/v1/runs", {
      url,
      key,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    report(result);
  }

  if (command === "import") {
    const raw = readInput(options, "file");
    const result = await request(`/api/v1/import${commonQuery(options)}`, {
      url,
      key,
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: raw,
    });
    report(result);
  }

  fail(`Unknown command "${command}". Run \`benchable help\`.`);
}

await main();
