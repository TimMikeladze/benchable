/**
 * `benchable login`: the CLI half of the device-code flow (docs/design.md). Sends only
 * which agent is asking; writes the minted key to the user's credentials file and the project
 * URL + slug (no secret) to `.benchable/config.json`.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  credentialsPath,
  normalizeUrl,
  readProjectConfig,
  saveCredential,
  writeProjectConfig,
  type ConfigEnv,
} from "./config";

export const LOGIN_CLIENTS = ["claude-code", "codex", "opencode", "cli", "other"] as const;

interface Pending {
  url: string;
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  interval: number;
}

export function pendingPath(where: Pick<ConfigEnv, "env" | "home">) {
  return join(dirname(credentialsPath(where)), "pending-login.json");
}

function readPending(where: Pick<ConfigEnv, "env" | "home">, url: string, now: Date): Pending | null {
  const path = pendingPath(where);
  if (!existsSync(path)) return null;
  try {
    const pending = JSON.parse(readFileSync(path, "utf8")) as Pending;
    if (pending.url !== url || new Date(pending.expiresAt) <= now) return null;
    return pending;
  } catch {
    return null;
  }
}

/** Best effort; a headless box just prints the URL. */
export function openBrowser(url: string) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Nothing to open with; the URL is already on screen.
  }
}

export interface LoginOptions {
  url: string;
  client: string;
  root: string;
  where: Pick<ConfigEnv, "env" | "home">;
  wait: boolean;
  browser: boolean;
  timeoutSeconds?: number;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export type LoginResult =
  | { status: "approved"; project: { slug: string; name: string; url: string }; credentials: string }
  | { status: "started"; verificationUrl: string; userCode: string }
  | { status: "denied" | "expired" | "timeout" };

export async function login(options: LoginOptions): Promise<LoginResult> {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());
  const url = normalizeUrl(options.url);

  let pending = readPending(options.where, url, now());
  if (!pending) {
    const response = await doFetch(`${url}/api/v1/connect`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client: options.client }),
    });
    if (!response.ok) throw new Error(`Could not start login: ${response.status} ${await response.text()}`);
    const body = (await response.json()) as Omit<Pending, "url" | "expiresAt"> & { expiresIn: number };
    pending = {
      url,
      deviceCode: body.deviceCode,
      userCode: body.userCode,
      verificationUrl: body.verificationUrl,
      interval: body.interval,
      expiresAt: new Date(now().getTime() + body.expiresIn * 1000).toISOString(),
    };
    const path = pendingPath(options.where);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(pending), { mode: 0o600 });
    if (options.browser) openBrowser(pending.verificationUrl);
  }

  log(`Open ${pending.verificationUrl}`);
  log(`and confirm the code ${pending.userCode}.`);

  if (!options.wait) return { status: "started", verificationUrl: pending.verificationUrl, userCode: pending.userCode };

  const deadline = Math.min(
    new Date(pending.expiresAt).getTime(),
    now().getTime() + (options.timeoutSeconds ?? 600) * 1000,
  );
  while (now().getTime() < deadline) {
    const response = await doFetch(`${url}/api/v1/connect/token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ deviceCode: pending.deviceCode }),
    });
    if (response.status === 429) {
      await sleep(pending.interval * 2000);
      continue;
    }
    if (!response.ok) throw new Error(`Login poll failed: ${response.status} ${await response.text()}`);
    const body = (await response.json()) as
      | { status: "pending" | "denied" | "expired" | "consumed" | "invalid" }
      | { status: "approved"; key: string; url: string; project: { slug: string; name: string; url: string } };

    if (body.status === "approved") {
      rmSync(pendingPath(options.where), { force: true });
      const credentials = saveCredential(options.where, {
        url,
        project: body.project.slug,
        key: body.key,
        name: body.project.name,
      });
      const { mode: _local, key: _key, ...rest } = readProjectConfig(options.root);
      writeProjectConfig(options.root, { ...rest, url, project: body.project.slug });
      return { status: "approved", project: body.project, credentials };
    }
    if (body.status !== "pending") {
      rmSync(pendingPath(options.where), { force: true });
      return { status: body.status === "denied" ? "denied" : "expired" };
    }
    await sleep(pending.interval * 1000);
  }
  return { status: "timeout" };
}
