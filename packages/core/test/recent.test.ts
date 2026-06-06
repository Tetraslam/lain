import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// recent.ts reads/writes ~/.config/lain/recent.json via os.homedir(); point HOME
// at a temp dir so the test is isolated. Import lazily after HOME is set.
let tmpHome: string;
let work: string;
let recent: typeof import("../src/recent.js");

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "lain-home-"));
  work = fs.mkdtempSync(path.join(os.tmpdir(), "lain-work-"));
  process.env.HOME = tmpHome;
  // Fresh module instance isn't needed (functions read homedir() each call), but
  // os.homedir() caches the env at call time on some platforms — set before use.
  recent = await import("../src/recent.js");
});
afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
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
