// Update checks — a subtle "a new version is available" nudge for all surfaces.
//
// Compares the installed git commit against the latest on the repo's main
// branch (via the GitHub API), cached for 24h so it never slows a command and
// hits the network at most once a day. Entirely fail-silent: no network, no
// git, or any error → reports "no update". Disable with LAIN_NO_UPDATE_CHECK=1.

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const REPO_SLUG = "Tetraslam/lain";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day
const CACHE_FILE = path.join(os.homedir(), ".config", "lain", "update-check.json");

export interface UpdateStatus {
  available: boolean;
  current: string | null;
  remote: string | null;
}

const NO_UPDATE: UpdateStatus = { available: false, current: null, remote: null };

/** The installed short commit, or null (not a git checkout / git absent). */
export function getLocalCommit(repoRoot: string): string | null {
  try {
    return execFileSync("git", ["-C", repoRoot, "rev-parse", "--short", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Relationship of a remote commit to local HEAD:
 *   "ancestor" → HEAD already contains it (we're up to date or ahead)
 *   "ahead"    → remote has commits HEAD lacks (a real update)
 *   "unknown"  → can't tell (object not fetched locally / git error)
 */
function remoteRelation(repoRoot: string, remoteSha: string): "ancestor" | "ahead" | "unknown" {
  try {
    execFileSync("git", ["-C", repoRoot, "cat-file", "-e", `${remoteSha}^{commit}`], { stdio: "ignore" });
  } catch {
    return "unknown"; // remote object isn't in the local clone — can't compare
  }
  try {
    execFileSync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", remoteSha, "HEAD"], { stdio: "ignore" });
    return "ancestor"; // exit 0
  } catch (err) {
    return (err as { status?: number }).status === 1 ? "ahead" : "unknown";
  }
}

/** Remove the cached remote SHA (call after a successful self-update). */
export function clearUpdateCache(): void {
  try { fs.rmSync(CACHE_FILE, { force: true }); } catch { /* ignore */ }
}

interface Cache {
  checkedAt: number;
  remote: string | null;
}

function readCache(): Cache | null {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8")) as Cache;
  } catch {
    return null;
  }
}

function writeCache(remote: string | null): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ checkedAt: Date.now(), remote } satisfies Cache));
  } catch {
    /* ignore */
  }
}

/** Fetch the latest commit SHA on main (plain text via the GitHub sha media type). */
async function fetchRemoteSha(timeoutMs = 2000): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`https://api.github.com/repos/${REPO_SLUG}/commits/main`, {
      headers: { "User-Agent": "lain-update-check", Accept: "application/vnd.github.sha" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.text()).trim();
  } catch {
    return null;
  }
}

/**
 * Check whether an update is available. Uses a 24h cache so the network is hit
 * at most once a day; `force` bypasses the cache. Always resolves (fail-silent).
 */
export async function checkForUpdate(repoRoot: string, opts: { force?: boolean } = {}): Promise<UpdateStatus> {
  if (process.env.LAIN_NO_UPDATE_CHECK === "1") return NO_UPDATE;

  const current = getLocalCommit(repoRoot);
  if (!current) return NO_UPDATE; // tarball / no git → can't compare

  let remote: string | null = null;
  const cache = readCache();
  const fresh = cache && Date.now() - cache.checkedAt < CHECK_INTERVAL_MS;

  if (fresh && !opts.force) {
    remote = cache!.remote;
  } else {
    remote = await fetchRemoteSha();
    if (remote) writeCache(remote);
    else if (cache) remote = cache.remote; // network failed; fall back to last known
  }

  let available = false;
  if (remote && current && !remote.startsWith(current)) {
    // Prefer git ancestry: only flag if the remote actually has commits HEAD
    // lacks (avoids a stale cache pointing at a now-older commit after update).
    const rel = remoteRelation(repoRoot, remote);
    available = rel === "ancestor" ? false : rel === "ahead" ? true : true;
  }
  return { available, current, remote: remote ? remote.slice(0, 7) : null };
}
