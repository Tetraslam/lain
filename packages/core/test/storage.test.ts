import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Storage } from "../src/storage.js";
import { Graph } from "../src/graph.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { LainNode, Exploration } from "@lain/shared";
import { nowISO } from "@lain/shared";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lain-test-"));
  dbPath = path.join(tmpDir, "test.db");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Storage", () => {
  it("creates database with schema", () => {
    const storage = new Storage(dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);
    storage.close();
  });

  it("creates and retrieves an exploration", () => {
    const storage = new Storage(dbPath);
    const now = nowISO();
    const exp: Exploration = {
      id: "test-exp",
      name: "Test Exploration",
      seed: "What if trees could talk?",
      n: 3,
      m: 2,
      strategy: "bf",
      planDetail: "sentence",
      extension: "freeform",
      createdAt: now,
      updatedAt: now,
    };

    storage.createExploration(exp);
    const retrieved = storage.getExploration("test-exp");

    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe("Test Exploration");
    expect(retrieved!.seed).toBe("What if trees could talk?");
    expect(retrieved!.n).toBe(3);
    expect(retrieved!.m).toBe(2);
    storage.close();
  });

  it("creates and retrieves nodes", () => {
    const storage = new Storage(dbPath);
    const now = nowISO();

    storage.createExploration({
      id: "exp1",
      name: "Test",
      seed: "seed",
      n: 3,
      m: 2,
      strategy: "bf",
      planDetail: "sentence",
      extension: "freeform",
      createdAt: now,
      updatedAt: now,
    });

    const node: LainNode = {
      id: "root",
      explorationId: "exp1",
      parentId: null,
      content: "Root content",
      contentConflict: null,
      title: "Root",
      depth: 0,
      branchIndex: 0,
      status: "complete",
      model: null,
      provider: null,
      planSummary: null,
      extensionData: null,
      createdAt: now,
      updatedAt: now,
    };

    storage.createNode(node);
    const retrieved = storage.getNode("root");

    expect(retrieved).not.toBeNull();
    expect(retrieved!.title).toBe("Root");
    expect(retrieved!.content).toBe("Root content");
    expect(retrieved!.depth).toBe(0);
    storage.close();
  });

  it("handles node status updates", () => {
    const storage = new Storage(dbPath);
    const now = nowISO();

    storage.createExploration({
      id: "exp1",
      name: "Test",
      seed: "seed",
      n: 3,
      m: 2,
      strategy: "bf",
      planDetail: "sentence",
      extension: "freeform",
      createdAt: now,
      updatedAt: now,
    });

    storage.createNode({
      id: "root",
      explorationId: "exp1",
      parentId: null,
      content: null,
      contentConflict: null,
      title: null,
      depth: 0,
      branchIndex: 0,
      status: "pending",
      model: null,
      provider: null,
      planSummary: null,
      extensionData: null,
      createdAt: now,
      updatedAt: now,
    });

    storage.updateNodeStatus("root", "generating");
    expect(storage.getNode("root")!.status).toBe("generating");

    storage.updateNodeContent("root", "My Title", "My content", "claude-sonnet-4-20250514", "anthropic");
    const node = storage.getNode("root")!;
    expect(node.status).toBe("complete");
    expect(node.title).toBe("My Title");
    expect(node.content).toBe("My content");

    storage.close();
  });

  it("prunes node and descendants", () => {
    const storage = new Storage(dbPath);
    const now = nowISO();

    storage.createExploration({
      id: "exp1",
      name: "Test",
      seed: "seed",
      n: 2,
      m: 2,
      strategy: "bf",
      planDetail: "sentence",
      extension: "freeform",
      createdAt: now,
      updatedAt: now,
    });

    // Create a small tree: root -> child1, child2 -> grandchild1
    for (const [id, parentId, depth, bi] of [
      ["root", null, 0, 0],
      ["root-1", "root", 1, 1],
      ["root-2", "root", 1, 2],
      ["root-1-1", "root-1", 2, 1],
    ] as const) {
      storage.createNode({
        id,
        explorationId: "exp1",
        parentId: parentId as string | null,
        content: `Content for ${id}`,
        contentConflict: null,
        title: id,
        depth,
        branchIndex: bi,
        status: "complete",
        model: null,
        provider: null,
        planSummary: null,
        extensionData: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Prune root-1 — should also prune root-1-1
    storage.pruneNode("root-1");

    expect(storage.getNode("root-1")!.status).toBe("pruned");
    expect(storage.getNode("root-1-1")!.status).toBe("pruned");
    expect(storage.getNode("root-2")!.status).toBe("complete");
    expect(storage.getNode("root")!.status).toBe("complete");

    storage.close();
  });

  it("handles crosslinks", () => {
    const storage = new Storage(dbPath);
    const now = nowISO();

    storage.createExploration({
      id: "exp1",
      name: "Test",
      seed: "seed",
      n: 2,
      m: 2,
      strategy: "bf",
      planDetail: "sentence",
      extension: "freeform",
      createdAt: now,
      updatedAt: now,
    });

    storage.createNode({
      id: "root",
      explorationId: "exp1",
      parentId: null,
      content: "Root",
      contentConflict: null,
      title: "Root",
      depth: 0,
      branchIndex: 0,
      status: "complete",
      model: null,
      provider: null,
      planSummary: null,
      extensionData: null,
      createdAt: now,
      updatedAt: now,
    });

    storage.createNode({
      id: "root-1",
      explorationId: "exp1",
      parentId: "root",
      content: "Branch 1",
      contentConflict: null,
      title: "Branch 1",
      depth: 1,
      branchIndex: 1,
      status: "complete",
      model: null,
      provider: null,
      planSummary: null,
      extensionData: null,
      createdAt: now,
      updatedAt: now,
    });

    storage.createNode({
      id: "root-2",
      explorationId: "exp1",
      parentId: "root",
      content: "Branch 2",
      contentConflict: null,
      title: "Branch 2",
      depth: 1,
      branchIndex: 2,
      status: "complete",
      model: null,
      provider: null,
      planSummary: null,
      extensionData: null,
      createdAt: now,
      updatedAt: now,
    });

    storage.createCrosslink({
      sourceId: "root-1",
      targetId: "root-2",
      label: "shared theme",
      aiSuggested: false,
      createdAt: now,
    });

    const links = storage.getCrosslinksForNode("root-1");
    expect(links).toHaveLength(1);
    expect(links[0].targetId).toBe("root-2");
    expect(links[0].label).toBe("shared theme");

    // Should also find via target
    const links2 = storage.getCrosslinksForNode("root-2");
    expect(links2).toHaveLength(1);

    storage.close();
  });
});

describe("Graph", () => {
  it("creates exploration with root node", () => {
    const storage = new Storage(dbPath);
    const graph = new Graph(storage);

    const exp = graph.createExploration({
      id: "test",
      name: "Test",
      seed: "What if gravity reversed?",
      n: 3,
      m: 2,
      strategy: "bf",
      planDetail: "sentence",
      extension: "freeform",
    });

    expect(exp.id).toBe("test");

    const root = graph.getNode("root");
    expect(root).not.toBeNull();
    expect(root!.content).toBe("What if gravity reversed?");
    expect(root!.depth).toBe(0);
    expect(root!.status).toBe("complete");

    storage.close();
  });

  it("creates child nodes with proper IDs", () => {
    const storage = new Storage(dbPath);
    const graph = new Graph(storage);

    graph.createExploration({
      id: "test",
      name: "Test",
      seed: "seed",
      n: 3,
      m: 2,
      strategy: "bf",
      planDetail: "sentence",
      extension: "freeform",
    });

    const children = graph.createChildNodes("test", "root", 3, [
      "Direction A",
      "Direction B",
      "Direction C",
    ]);

    expect(children).toHaveLength(3);
    expect(children[0].id).toBe("root-1");
    expect(children[1].id).toBe("root-2");
    expect(children[2].id).toBe("root-3");
    expect(children[0].planSummary).toBe("Direction A");
    expect(children[0].depth).toBe(1);
    expect(children[0].status).toBe("pending");

    // Create grandchildren
    storage.updateNodeStatus("root-1", "complete");
    const grandchildren = graph.createChildNodes("test", "root-1", 2);
    expect(grandchildren[0].id).toBe("root-1-1");
    expect(grandchildren[1].id).toBe("root-1-2");
    expect(grandchildren[0].depth).toBe(2);

    storage.close();
  });

  it("returns ancestor chain", () => {
    const storage = new Storage(dbPath);
    const graph = new Graph(storage);

    graph.createExploration({
      id: "test",
      name: "Test",
      seed: "seed",
      n: 2,
      m: 3,
      strategy: "bf",
      planDetail: "sentence",
      extension: "freeform",
    });

    const children = graph.createChildNodes("test", "root", 2);
    storage.updateNodeContent("root-1", "Child 1", "content", "model", "anthropic");
    const grandchildren = graph.createChildNodes("test", "root-1", 2);

    const ancestors = graph.getAncestorChain("root-1-1");
    expect(ancestors).toHaveLength(2);
    expect(ancestors[0].id).toBe("root");
    expect(ancestors[1].id).toBe("root-1");

    storage.close();
  });

  it("returns siblings", () => {
    const storage = new Storage(dbPath);
    const graph = new Graph(storage);

    graph.createExploration({
      id: "test",
      name: "Test",
      seed: "seed",
      n: 3,
      m: 2,
      strategy: "bf",
      planDetail: "sentence",
      extension: "freeform",
    });

    graph.createChildNodes("test", "root", 3);

    const siblings = graph.getSiblings("root-2");
    expect(siblings).toHaveLength(2);
    expect(siblings.map((s) => s.id).sort()).toEqual(["root-1", "root-3"]);

    storage.close();
  });
});
