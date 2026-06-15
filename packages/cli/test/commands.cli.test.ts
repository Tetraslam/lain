// Integration tests for the two papercuts from issues #1 and #2:
//  1. an inferred `explore` whose "seed" is a mistyped command must error with a
//     suggestion instead of silently starting an expensive exploration;
//  2. read commands resolve a lain exploration without --db — skipping dotfiles
//     and unrelated sqlite files, defaulting to the most recent when ambiguous.
// These spawn the real CLI in a sandboxed HOME (with a config so the explore
// path doesn't trip first-run auto-init), and build fixtures under bun.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "../src/index.ts");
const MKFIX = path.resolve(HERE, "_mkfixture.ts");

let home: string;
let work: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lain-cmd-home-"));
  work = fs.mkdtempSync(path.join(os.tmpdir(), "lain-cmd-work-"));
  // A config so explore/read commands don't drop into first-run setup.
  fs.mkdirSync(path.join(home, ".config/lain"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config/lain/config.json"),
    JSON.stringify({ defaultProvider: "bedrock", defaultModel: "claude-sonnet-4-6" }));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

function lain(args: string[], extraEnv: Record<string, string> = {}) {
  const r = spawnSync("bun", [CLI, ...args], {
    cwd: work,
    env: { ...process.env, HOME: home, NO_COLOR: "1", ...extraEnv },
    encoding: "utf-8",
  });
  return { code: r.status ?? -1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim(), all: `${r.stdout}\n${r.stderr}` };
}

function mkFixture(kind: "lain" | "other", name: string) {
  const r = spawnSync("bun", [MKFIX, kind, path.join(work, name)], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`fixture build failed: ${r.stderr}`);
}

describe("issue #1: mistyped command must not start an exploration", () => {
  it("`lain list` errors with a suggestion and creates no db", () => {
    const r = lain(["list"]);
    expect(r.code).not.toBe(0);
    expect(r.all.toLowerCase()).toContain("subcommand");
    expect(r.all).not.toContain("Creating exploration");
    expect(fs.readdirSync(work).filter((f) => f.endsWith(".db"))).toHaveLength(0);
  });

  it("a near-typo of a real command suggests it", () => {
    const r = lain(["tre"]);
    expect(r.code).not.toBe(0);
    expect(r.all).toContain("lain tree");
    expect(r.all).not.toContain("Creating exploration");
  });

  it("a genuine single-word seed is NOT blocked by the guard", () => {
    // No creds → it fails later, but it must get PAST the guard (i.e. reach the
    // exploration path), not be mistaken for a command.
    const r = lain(["entropy"]);
    expect(r.all.toLowerCase()).not.toContain("isn't a lain command");
    expect(r.all).not.toContain('Did you mean `lain');
    expect(r.all).toContain("Creating exploration");
  });

  it("`lain explore <word>` is the escape hatch (explicit → no guard)", () => {
    const r = lain(["explore", "list"]);
    // Explicit explore proceeds (and only fails later on missing creds).
    expect(r.all).not.toContain("isn't a lain command");
    expect(r.all).toContain("Creating exploration");
  });
});

describe("issue #2: read commands resolve the right db without --db", () => {
  it("picks the lain exploration, ignoring dotfiles and non-lain dbs", () => {
    mkFixture("lain", "idea.db");
    mkFixture("other", ".claude-peers.db"); // hidden, unrelated
    mkFixture("other", "random.db");        // visible, unrelated
    const r = lain(["tree"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("fixture exploration");
  });

  it("errors helpfully when only non-lain dbs are present", () => {
    mkFixture("other", "random.db");
    const r = lain(["tree"]);
    expect(r.code).not.toBe(0);
    expect(r.all).toContain("non-lain");
  });

  it("defaults to the most-recently-modified exploration and says so", () => {
    mkFixture("lain", "older.db");
    mkFixture("lain", "newer.db");
    const now = Date.now();
    fs.utimesSync(path.join(work, "older.db"), new Date(now - 60_000), new Date(now - 60_000));
    fs.utimesSync(path.join(work, "newer.db"), new Date(now), new Date(now));
    const r = lain(["tree"]);
    expect(r.code).toBe(0);
    expect(r.all).toContain("most recent");
    expect(r.all).toContain("newer.db");
  });

  it("honors LAIN_DB", () => {
    mkFixture("lain", "idea.db");
    mkFixture("lain", "other-exploration.db");
    const r = lain(["tree"], { LAIN_DB: path.join(work, "idea.db") });
    expect(r.code).toBe(0);
    expect(r.all).not.toContain("most recent"); // unambiguous → no notice
  });
});
