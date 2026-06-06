// Recently-opened explorations + extra discovery directories.
//
// Persisted to ~/.config/lain/recent.json so the TUI, web, and CLI all surface
// the same set of databases — not just whatever's in the current directory.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const STORE = path.join(os.homedir(), ".config", "lain", "recent.json");

interface Store {
  recents: string[]; // absolute .db paths, most-recent first
  dirs: string[]; // extra directories to scan
}

function read(): Store {
  try {
    const s = JSON.parse(fs.readFileSync(STORE, "utf-8")) as Partial<Store>;
    return { recents: s.recents ?? [], dirs: s.dirs ?? [] };
  } catch {
    return { recents: [], dirs: [] };
  }
}

function write(s: Store): void {
  try {
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    fs.writeFileSync(STORE, JSON.stringify(s, null, 2));
  } catch {
    /* ignore */
  }
}

const expand = (p: string) => path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));
const exists = (p: string) => { try { return fs.existsSync(p); } catch { return false; } };

/** Record that a db was opened (front of the recents list). */
export function addRecentDb(dbPath: string): void {
  const abs = path.resolve(dbPath);
  if (!exists(abs)) return;
  const s = read();
  s.recents = [abs, ...s.recents.filter((p) => p !== abs)].slice(0, 25);
  write(s);
}

/** Recently-opened db paths that still exist. */
export function getRecentDbs(): string[] {
  return read().recents.filter(exists);
}

/** Extra directories the user added to scan for explorations. */
export function getDiscoveryDirs(): string[] {
  return read().dirs.filter(exists);
}

export function addDiscoveryDir(dir: string): string {
  const abs = expand(dir);
  const s = read();
  if (!s.dirs.includes(abs)) s.dirs = [abs, ...s.dirs].slice(0, 25);
  write(s);
  return abs;
}

export function removeDiscoveryDir(dir: string): void {
  const abs = expand(dir);
  const s = read();
  s.dirs = s.dirs.filter((d) => d !== abs);
  write(s);
}

/**
 * All .db file paths to surface: the current dir (+ up to 4 parents), every
 * configured discovery dir, and recently-opened dbs. Deduped, existing only.
 */
export function collectDbFiles(cwd: string): string[] {
  const files = new Set<string>();
  const scanDir = (dir: string) => {
    try {
      for (const e of fs.readdirSync(dir)) if (e.endsWith(".db")) files.add(path.join(dir, e));
    } catch {
      /* ignore unreadable dirs */
    }
  };

  let dir = cwd;
  for (let i = 0; i < 4; i++) {
    scanDir(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const d of getDiscoveryDirs()) scanDir(d);
  for (const r of getRecentDbs()) files.add(r);

  return [...files].filter((f) => {
    try { return fs.statSync(f).isFile(); } catch { return false; }
  });
}
