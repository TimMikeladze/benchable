/**
 * Where the CLI's settings come from, and which mode that puts it in (docs/design.md).
 *
 * Pure apart from reading and writing the two config files: env, cwd and home are passed in,
 * so the tests can build any combination without touching the real machine.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const DEFAULT_URL = "https://benchable.sh";

export type Mode = "cloud" | "local" | "unconfigured";

export interface ProjectConfig {
  url?: string;
  project?: string;
  /** Allowed, but warned about: this file is meant to be committable. */
  key?: string;
  /** `local` when the person chose not to connect an account. */
  mode?: "local";
}

export interface Credentials {
  [url: string]: {
    default?: string;
    projects: Record<string, { key: string; name?: string }>;
  };
}

export interface ConfigEnv {
  env: Record<string, string | undefined>;
  cwd: string;
  home: string;
}

export type Source = "env" | "project" | "credentials" | "default";

export interface ResolvedConfig {
  mode: Mode;
  /** The directory that holds (or will hold) `.benchable/`. */
  root: string;
  url: string | null;
  key: string | null;
  project: string | null;
  sources: { url?: Source; key?: Source; project?: Source };
  warnings: string[];
}

export function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * The nearest ancestor with a `.benchable/` folder, else the git root, else `cwd`. So the CLI
 * finds the same history from any subdirectory of a repo.
 */
export function findRoot(cwd: string): string {
  let gitRoot: string | null = null;
  let dir = resolve(cwd);
  while (true) {
    if (existsSync(join(dir, ".benchable"))) return dir;
    if (!gitRoot && existsSync(join(dir, ".git"))) gitRoot = dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return gitRoot ?? resolve(cwd);
}

export function benchableDir(root: string): string {
  return join(root, ".benchable");
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function projectConfigPath(root: string): string {
  return join(benchableDir(root), "config.json");
}

export function readProjectConfig(root: string): ProjectConfig {
  return readJson<ProjectConfig>(projectConfigPath(root)) ?? {};
}

export function writeProjectConfig(root: string, config: ProjectConfig): void {
  const path = projectConfigPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

export function credentialsPath({ env, home }: Pick<ConfigEnv, "env" | "home">): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return join(base, "benchable", "credentials.json");
}

export function readCredentials(where: Pick<ConfigEnv, "env" | "home">): Credentials {
  return readJson<Credentials>(credentialsPath(where)) ?? {};
}

/** Written 0600: it holds API keys. */
export function saveCredential(
  where: Pick<ConfigEnv, "env" | "home">,
  entry: { url: string; project: string; key: string; name?: string },
): string {
  const path = credentialsPath(where);
  const credentials = readCredentials(where);
  const url = normalizeUrl(entry.url);
  const forUrl = credentials[url] ?? { projects: {} };
  forUrl.projects[entry.project] = { key: entry.key, ...(entry.name ? { name: entry.name } : {}) };
  forUrl.default = entry.project;
  credentials[url] = forUrl;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/**
 * Resolve each field from the first source that has it: env, then the project file, then the
 * user's credentials file. Cloud needs a url and a key; an explicit `"mode": "local"` in the
 * project file wins over credentials but not over env, so CI with secrets set always uploads.
 */
export function resolveConfig(where: ConfigEnv): ResolvedConfig {
  const root = findRoot(where.cwd);
  const projectFile = readProjectConfig(root);
  const credentials = readCredentials(where);
  const warnings: string[] = [];
  const sources: ResolvedConfig["sources"] = {};

  let url: string | null = null;
  if (where.env.BENCHABLE_URL?.trim()) {
    url = normalizeUrl(where.env.BENCHABLE_URL);
    sources.url = "env";
  } else if (projectFile.url) {
    url = normalizeUrl(projectFile.url);
    sources.url = "project";
  } else {
    const stored = Object.keys(credentials);
    if (stored.length === 1) {
      url = stored[0];
      sources.url = "credentials";
    }
  }

  let project: string | null = null;
  if (projectFile.project) {
    project = projectFile.project;
    sources.project = "project";
  } else if (url && credentials[url]?.default) {
    project = credentials[url].default ?? null;
    sources.project = "credentials";
  }

  let key: string | null = null;
  if (where.env.BENCHABLE_KEY?.trim()) {
    key = where.env.BENCHABLE_KEY.trim();
    sources.key = "env";
  } else if (projectFile.key) {
    key = projectFile.key;
    sources.key = "project";
    warnings.push(".benchable/config.json holds an API key; keep it out of git or move it to BENCHABLE_KEY.");
  } else if (url) {
    const forUrl = credentials[url];
    const entry = (project && forUrl?.projects[project]) || (forUrl?.default && forUrl.projects[forUrl.default]);
    if (entry) {
      key = entry.key;
      sources.key = "credentials";
    }
  }

  const envCloud = sources.url === "env" && sources.key === "env";
  let mode: Mode;
  if (url && key && (envCloud || projectFile.mode !== "local")) mode = "cloud";
  else if (projectFile.mode === "local") mode = "local";
  else mode = "unconfigured";

  if (mode !== "cloud" && key && !url) warnings.push("BENCHABLE_KEY is set but no URL is; set BENCHABLE_URL too.");

  return { mode, root, url, key, project, sources, warnings };
}

export function maskKey(key: string): string {
  return key.length > 12 ? `${key.slice(0, 8)}…${key.slice(-4)}` : "…";
}
