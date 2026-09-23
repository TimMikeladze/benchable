/** Mode detection and config precedence for the agent skill's CLI (docs/agent-skill.md). */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { credentialsPath, findRoot, resolveConfig, saveCredential, writeProjectConfig } from "../src/cli/config";
import { mcpSnippet } from "../src/cli/mcp-config";

let base = "";
let repo = "";
let home = "";

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "benchable-config-"));
  repo = join(base, "repo");
  home = join(base, "home");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "packages", "app"), { recursive: true });
  mkdirSync(home, { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const resolve = (env: Record<string, string> = {}, cwd = repo) => resolveConfig({ env, cwd, home });

describe("resolveConfig", () => {
  test("nothing configured is unconfigured", () => {
    expect(resolve().mode).toBe("unconfigured");
  });

  test("env url + key is cloud and wins over everything", () => {
    writeProjectConfig(repo, { mode: "local" });
    const config = resolve({ BENCHABLE_URL: "https://bench.example.com/", BENCHABLE_KEY: "bmk_envkey_123456" });
    expect(config).toMatchObject({ mode: "cloud", url: "https://bench.example.com", key: "bmk_envkey_123456" });
    expect(config.sources).toMatchObject({ url: "env", key: "env" });
  });

  test("a key alone is not enough, and says why", () => {
    const config = resolve({ BENCHABLE_KEY: "bmk_envkey_123456" });
    expect(config.mode).toBe("unconfigured");
    expect(config.warnings.join(" ")).toContain("BENCHABLE_URL");
  });

  test("login's files resolve to cloud from any subdirectory", () => {
    saveCredential({ env: {}, home }, { url: "https://benchable.sh", project: "web", key: "bmk_fromlogin_1234" });
    writeProjectConfig(repo, { url: "https://benchable.sh", project: "web" });
    const config = resolve({}, join(repo, "packages", "app"));
    expect(config).toMatchObject({ mode: "cloud", project: "web", key: "bmk_fromlogin_1234", root: repo });
    expect(config.sources).toMatchObject({ url: "project", key: "credentials", project: "project" });
  });

  test("credentials are written 0600 under XDG_CONFIG_HOME", () => {
    const xdg = join(base, "xdg");
    const path = saveCredential({ env: { XDG_CONFIG_HOME: xdg }, home }, { url: "https://x.dev", project: "p", key: "bmk_k_1234567890" });
    expect(path).toBe(credentialsPath({ env: { XDG_CONFIG_HOME: xdg }, home }));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("explicit local mode beats stored credentials", () => {
    saveCredential({ env: {}, home }, { url: "https://benchable.sh", project: "web", key: "bmk_fromlogin_1234" });
    writeProjectConfig(repo, { mode: "local" });
    expect(resolve().mode).toBe("local");
  });

  test("a key in the committable project file works but warns", () => {
    writeProjectConfig(repo, { url: "https://x.dev", key: "bmk_inrepo_123456" });
    const config = resolve();
    expect(config.mode).toBe("cloud");
    expect(config.warnings[0]).toContain("API key");
  });

  test("findRoot prefers an existing .benchable over the git root", () => {
    mkdirSync(join(repo, "packages", "app", ".benchable"));
    expect(findRoot(join(repo, "packages", "app"))).toBe(join(repo, "packages", "app"));
    writeFileSync(join(repo, "file"), "");
    expect(findRoot(join(repo, "packages"))).toBe(repo);
  });
});

describe("mcpSnippet", () => {
  test("never inlines a key", () => {
    for (const agent of ["claude-code", "codex", "opencode"] as const) {
      const snippet = mcpSnippet(agent, "https://benchable.sh/");
      expect(snippet).toContain("https://benchable.sh/api/mcp");
      expect(snippet).toContain("BENCHABLE_KEY");
      expect(snippet).not.toContain("bmk_");
    }
  });
});
