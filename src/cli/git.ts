import { execFileSync } from "node:child_process";

function git(args: string[], cwd: string): string | undefined {
  try {
    const out = execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** Branch and commit of the working tree, when there is one. Read locally, never sent anywhere else. */
export function gitInfo(cwd: string): { branch?: string; commitSha?: string } {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return {
    branch: branch && branch !== "HEAD" ? branch : undefined,
    commitSha: git(["rev-parse", "HEAD"], cwd),
  };
}
