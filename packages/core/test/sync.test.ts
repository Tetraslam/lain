import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Storage } from "../src/storage.js";
import { Graph } from "../src/graph.js";
import { Exporter } from "../src/export.js";
import { Sync } from "../src/sync.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import matter from "gray-matter";

let tmpDir: string;
let dbPath: string;
let outputDir: string;

function createTestExploration(storage: Storage, graph: Graph) {
  graph.createExploration({
    id: "test",
    name: "Test Exploration",
    seed: "What if trees could talk?",
    n: 2,
    m: 2,
    strategy: "bf",
    planDetail: "sentence",
    extension: "freeform",
  });

  // Create some children
  graph.createChildNodes("test", "root", 2, [
    "Linguistic evolution of tree communication",
    "Social structures in arboreal societies",
  ]);

  // Complete the children
  storage.updateNodeContent(
    "root-1",
    "Linguistic Evolution",
    "Trees developed a complex language based on chemical signals...",
    "claude-sonnet-4-20250514",
    "anthropic"
  );
  storage.updateNodeContent(
    "root-2",
    "Arboreal Societies",
    "Once trees could communicate, they formed councils...",
    "claude-sonnet-4-20250514",
    "anthropic"
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lain-test-"));
  dbPath = path.join(tmpDir, "test.db");
  outputDir = path.join(tmpDir, "output");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Exporter", () => {
  it("exports exploration to markdown files", () => {
    const storage = new Storage(dbPath);
    const graph = new Graph(storage);
    const exporter = new Exporter(storage);

    createTestExploration(storage, graph);
    exporter.export("test", outputDir);

    // Check files exist
    expect(fs.existsSync(path.join(outputDir, "_index.md"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "root.md"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "root-1.md"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "root-2.md"))).toBe(true);

    // Check root node content
    const rootFile = fs.readFileSync(path.join(outputDir, "root.md"), "utf-8");
    const parsed = matter(rootFile);
    expect(parsed.data.id).toBe("root");
    expect(parsed.data.children).toContain("root-1");
    expect(parsed.data.children).toContain("root-2");
    expect(parsed.data.depth).toBe(0);

    // Check child node content
    const child1File = fs.readFileSync(path.join(outputDir, "root-1.md"), "utf-8");
    const parsed1 = matter(child1File);
    expect(parsed1.data.id).toBe("root-1");
    expect(parsed1.data.parent).toBe("root");
    expect(parsed1.data.depth).toBe(1);
    expect(parsed1.content).toContain("chemical signals");

    // Check wikilinks exist
    expect(child1File).toContain("[[root|");
    expect(rootFile).toContain("[[root-1|");

    storage.close();
  });

  it("exports index with tree structure", () => {
    const storage = new Storage(dbPath);
    const graph = new Graph(storage);
    const exporter = new Exporter(storage);

    createTestExploration(storage, graph);
    exporter.export("test", outputDir);

    const indexFile = fs.readFileSync(path.join(outputDir, "_index.md"), "utf-8");
    expect(indexFile).toContain("Test Exploration");
    expect(indexFile).toContain("What if trees could talk?");
    expect(indexFile).toContain("[[root|");
    expect(indexFile).toContain("[[root-1|");

    storage.close();
  });

  it("skips pruned nodes", () => {
    const storage = new Storage(dbPath);
    const graph = new Graph(storage);
    const exporter = new Exporter(storage);

    createTestExploration(storage, graph);
    graph.pruneNode("root-2");
    exporter.export("test", outputDir);

    expect(fs.existsSync(path.join(outputDir, "root-1.md"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "root-2.md"))).toBe(false);

    storage.close();
  });
});

describe("Sync", () => {
  it("push writes files and records sync state", () => {
    const storage = new Storage(dbPath);
    const graph = new Graph(storage);
    const sync = new Sync(storage);

    createTestExploration(storage, graph);
    const result = sync.push("test", outputDir);

    expect(result.pushed.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(outputDir, "root.md"))).toBe(true);

    // Check sync state was recorded
    const state = storage.getSyncState("root");
    expect(state).not.toBeNull();
    expect(state!.contentHash).toBeTruthy();
    expect(state!.frontmatterHash).toBeTruthy();

    storage.close();
  });

  it("pull detects file changes", () => {
    const storage = new Storage(dbPath);
    const graph = new Graph(storage);
    const sync = new Sync(storage);

    createTestExploration(storage, graph);
    sync.push("test", outputDir);

    // Edit a file externally
    const filePath = path.join(outputDir, "root-1.md");
    const content = fs.readFileSync(filePath, "utf-8");
    const modified = content.replace(
      "chemical signals",
      "chemical signals and pheromone networks"
    );
    fs.writeFileSync(filePath, modified);

    // Pull changes
    const result = sync.pull("test", outputDir);
    expect(result.pulled).toContain("root-1");

    // Verify db was updated
    const node = graph.getNode("root-1");
    expect(node!.content).toContain("pheromone networks");

    storage.close();
  });

  it("pull detects file deletion as prune", () => {
    const storage = new Storage(dbPath);
    const graph = new Graph(storage);
    const sync = new Sync(storage);

    createTestExploration(storage, graph);
    sync.push("test", outputDir);

    // Delete a file
    fs.unlinkSync(path.join(outputDir, "root-2.md"));

    const result = sync.pull("test", outputDir);
    expect(result.pruned).toContain("root-2");

    const node = graph.getNode("root-2");
    expect(node!.status).toBe("pruned");

    storage.close();
  });

  it("bidirectional sync handles non-conflicting changes", () => {
    const storage = new Storage(dbPath);
    const graph = new Graph(storage);
    const sync = new Sync(storage);

    createTestExploration(storage, graph);
    sync.push("test", outputDir);

    // Edit file externally
    const filePath = path.join(outputDir, "root-1.md");
    const content = fs.readFileSync(filePath, "utf-8");
    const modified = content.replace("chemical signals", "quantum signals");
    fs.writeFileSync(filePath, modified);

    // Full sync
    const result = sync.sync("test", outputDir);

    // File change should have been pulled
    const node = graph.getNode("root-1");
    expect(node!.content).toContain("quantum signals");

    storage.close();
  });

  it("status reports changes without modifying anything", () => {
    const storage = new Storage(dbPath);
    const graph = new Graph(storage);
    const sync = new Sync(storage);

    createTestExploration(storage, graph);
    sync.push("test", outputDir);

    // Edit a file
    const filePath = path.join(outputDir, "root-1.md");
    const content = fs.readFileSync(filePath, "utf-8");
    fs.writeFileSync(filePath, content.replace("chemical", "quantum"));

    const status = sync.status("test", outputDir);
    expect(status.fileChanged).toContain("root-1");
    expect(status.dbChanged).toHaveLength(0);

    // Node should NOT be updated (status is read-only)
    const node = graph.getNode("root-1");
    expect(node!.content).toContain("chemical");

    storage.close();
  });
});
