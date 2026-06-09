import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import * as recent from "../src/recent.js";

// recent.ts resolves its store via LAIN_CONFIG_DIR (lazily, per call), so each
// test gets a fully isolated store regardless of suite ordering.
let cfg: string;
let work: string;

beforeEach(() => {
  cfg = fs.mkdtempSync(path.join(os.tmpdir(), "lain-cfg-"));
  work = fs.mkdtempSync(path.join(os.tmpdir(), "lain-work-"));
  process.env.LAIN_CONFIG_DIR = cfg;
});
afterEach(() => {
  delete process.env.LAIN_CONFIG_DIR;
  fs.rmSync(cfg, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

describe("recent store", () => {
  it("records recents most-recent-first, deduped, existing-only", () => {
    const a = path.join(work, "a.db"); fs.writeFileSync(a, "");
    const b = path.join(work, "b.db"); fs.writeFileSync(b, "");
    recent.addRecentDb(a);
    recent.addRecentDb(b);
    recent.addRecentDb(a); // re-open a → moves to front, no dupe
    expect(recent.getRecentDbs()).toEqual([a, b]);

    fs.rmSync(b);
    expect(recent.getRecentDbs()).toEqual([a]); // missing files filtered
  });

  it("adds/removes discovery dirs", () => {
    const d = recent.addDiscoveryDir(work);
    expect(recent.getDiscoveryDirs()).toContain(d);
    recent.removeDiscoveryDir(work);
    expect(recent.getDiscoveryDirs()).not.toContain(d);
  });

  it("collectDbFiles unions cwd, dirs, and recents", () => {
    const cwdDb = path.join(work, "in-cwd.db"); fs.writeFileSync(cwdDb, "");
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "lain-other-"));
    const otherDb = path.join(otherDir, "elsewhere.db"); fs.writeFileSync(otherDb, "");
    try {
      recent.addDiscoveryDir(otherDir);
      const found = recent.collectDbFiles(work);
      expect(found).toContain(cwdDb);
      expect(found).toContain(otherDb);
      // deduped
      expect(new Set(found).size).toBe(found.length);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });
});
