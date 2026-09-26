/**
 * `benchable local sync`: move `.benchable/runs/` into a cloud project with nothing lost and
 * nothing duplicated (docs/design.md). Every step is idempotent: the run by its embedded
 * `idempotencyKey`, each artifact by name + sha256.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { benchableDir } from "../config";
import { listLocalRuns } from "./store";

export interface SyncTarget {
  url: string;
  key: string;
  project: string | null;
}

export type SyncState = Record<string, Record<string, { runId: string; url: string | null }>>;

export function syncStatePath(root: string) {
  return join(benchableDir(root), "sync.json");
}

export function readSyncState(root: string): SyncState {
  const path = syncStatePath(root);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SyncState;
  } catch {
    return {};
  }
}

export function targetKey(target: Pick<SyncTarget, "url" | "project">) {
  return `${target.url}#${target.project ?? ""}`;
}

/** idempotencyKey → cloud run URL for the given target, for linking synced runs. */
export function cloudUrls(root: string, target: Pick<SyncTarget, "url" | "project"> | null): Record<string, string> {
  if (!target) return {};
  const entries = readSyncState(root)[targetKey(target)] ?? {};
  return Object.fromEntries(
    Object.entries(entries).flatMap(([key, value]) => (value.url ? [[key, value.url]] : [])),
  );
}

export interface SyncOutcome {
  stem: string;
  runId?: string;
  url?: string | null;
  idempotent?: boolean;
  artifactsUploaded: number;
  error?: string;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export async function syncLocal(
  root: string,
  target: SyncTarget,
  options: { fetch?: Fetch; onProgress?: (outcome: SyncOutcome) => void } = {},
): Promise<SyncOutcome[]> {
  const doFetch: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const auth = { authorization: `Bearer ${target.key}` };
  const state = readSyncState(root);
  const forTarget = (state[targetKey(target)] ??= {});
  const outcomes: SyncOutcome[] = [];

  for (const { stem, run } of listLocalRuns(root)) {
    const outcome: SyncOutcome = { stem, artifactsUploaded: 0 };
    try {
      const { artifacts, ...payload } = run;
      const response = await doFetch(`${target.url}/api/v1/runs`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 300)}`);
      const body = JSON.parse(text) as { runId: string; url?: string; idempotent: boolean };
      outcome.runId = body.runId;
      outcome.url = body.url ?? null;
      outcome.idempotent = body.idempotent;

      if (artifacts?.length) {
        const listing = await doFetch(`${target.url}/api/v1/runs/${encodeURIComponent(body.runId)}/artifacts`, {
          headers: { ...auth, accept: "application/json" },
        });
        if (!listing.ok) throw new Error(`listing artifacts: ${listing.status} ${await listing.text()}`);
        const existing = ((await listing.json()) as { artifacts: Array<{ name: string; checksum: string }> }).artifacts;
        for (const artifact of artifacts) {
          if (existing.some((row) => row.name === artifact.name && row.checksum === artifact.sha256)) continue;
          const bytes = readFileSync(join(benchableDir(root), artifact.path));
          const query = new URLSearchParams({ name: artifact.name });
          if (artifact.kind) query.set("kind", artifact.kind);
          const upload = await doFetch(
            `${target.url}/api/v1/runs/${encodeURIComponent(body.runId)}/artifacts?${query.toString()}`,
            { method: "POST", headers: { ...auth, "content-type": "application/octet-stream" }, body: bytes },
          );
          if (!upload.ok) throw new Error(`uploading ${artifact.name}: ${upload.status} ${await upload.text()}`);
          outcome.artifactsUploaded += 1;
        }
      }

      forTarget[run.idempotencyKey] = { runId: body.runId, url: outcome.url ?? null };
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : String(error);
    }
    outcomes.push(outcome);
    options.onProgress?.(outcome);
  }

  writeFileSync(syncStatePath(root), `${JSON.stringify(state, null, 2)}\n`);
  return outcomes;
}
