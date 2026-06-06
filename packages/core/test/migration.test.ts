import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "bun:sqlite";
import { Storage, CURRENT_SCHEMA_VERSION } from "../src/storage.js";
import { Graph } from "../src/graph.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lain-migrate-"));
  dbPath = path.join(tmp, "t.db");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("schema versioning", () => {
  it("stamps a fresh db at the current version", () => {
    const s = new Storage(dbPath);
    expect(s.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    s.close();
  });

  it("upgrades a legacy (v1) db in place without data loss", () => {
    // Simulate an old db: only the original tables, no substrate tables, no meta.
    const raw = new Database(dbPath, { create: true });
    raw.exec(`
      CREATE TABLE exploration (id TEXT PRIMARY KEY, name TEXT NOT NULL, seed TEXT NOT NULL, n INTEGER NOT NULL, m INTEGER NOT NULL, strategy TEXT, plan_detail TEXT, extension TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE node (id TEXT PRIMARY KEY, exploration_id TEXT NOT NULL, parent_id TEXT, content TEXT, content_conflict TEXT, title TEXT, depth INTEGER NOT NULL, branch_index INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', model TEXT, provider TEXT, plan_summary TEXT, extension_data TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
    raw.prepare("INSERT INTO exploration (id,name,seed,n,m,strategy,plan_detail,extension,created_at,updated_at) VALUES ('old','Legacy','seed',2,1,'bf','sentence','freeform','t','t')").run();
    raw.prepare("INSERT INTO node (id,exploration_id,parent_id,depth,branch_index,status,title,content,created_at,updated_at) VALUES ('root','old',NULL,0,0,'complete','Legacy Root','old content','t','t')").run();
    raw.close();

    // Open with current Storage — should migrate (add substrate tables) and preserve data.
    const s = new Storage(dbPath);
    expect(s.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION);

    const g = new Graph(s);
    const exp = g.getAllExplorations();
    expect(exp).toHaveLength(1);
    expect(g.getNode("root")?.content).toBe("old content");

    // Substrate tables now work on the upgraded db.
    s.upsertMission({ explorationId: "old", intent: "x", criteria: ["y"], createdAt: "t" });
    expect(s.getMission("old")?.intent).toBe("x");
    expect(s.getCorpusSources("old")).toEqual([]);
    s.close();
  });

  it("is idempotent across reopens", () => {
    new Storage(dbPath).close();
    const s2 = new Storage(dbPath);
    expect(s2.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    s2.close();
  });
});
