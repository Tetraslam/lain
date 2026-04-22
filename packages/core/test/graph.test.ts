import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Storage } from "../src/storage.js";
import { Graph } from "../src/graph.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { Exploration, LainNode } from "@lain/shared";
import { nowISO } from "@lain/shared";

let tmpDir: string;
let dbPath: string;
let storage: Storage;
let graph: Graph;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lain-graph-test-"));
  dbPath = path.join(tmpDir, "test.db");
  storage = new Storage(dbPath);
  graph = new Graph(storage);
});

afterEach(() => {
  storage.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createTestExploration(): Exploration {
  return graph.createExploration({
    id: "test-exp",
    name: "Test Exploration",
    seed: "What if trees could talk",
    n: 3,
    m: 2,
    strategy: "bf",
    planDetail: "sentence",
    extension: "freeform",
  });
}

describe("Graph", () => {
  describe("createExploration", () => {
    it("creates an exploration with a root node", () => {
      const exp = createTestExploration();
      expect(exp.id).toBe("test-exp");
      expect(exp.name).toBe("Test Exploration");

      const root = graph.getNode("root");
      expect(root).not.toBeNull();
      expect(root!.depth).toBe(0);
      expect(root!.status).toBe("complete");
      expect(root!.content).toBe("What if trees could talk");
    });
  });

  describe("createChildNodes", () => {
    it("creates children with correct IDs and indices", () => {
      createTestExploration();
      const children = graph.createChildNodes("test-exp", "root", 3, [
        "Direction A",
        "Direction B",
        "Direction C",
      ]);

      expect(children).toHaveLength(3);
      expect(children[0].id).toBe("root-1");
      expect(children[1].id).toBe("root-2");
      expect(children[2].id).toBe("root-3");
      expect(children[0].branchIndex).toBe(1);
      expect(children[0].planSummary).toBe("Direction A");
      expect(children[0].depth).toBe(1);
      expect(children[0].status).toBe("pending");
    });

    it("continues indexing from existing children", () => {
      createTestExploration();
      graph.createChildNodes("test-exp", "root", 2);
      const more = graph.createChildNodes("test-exp", "root", 2);

      expect(more[0].id).toBe("root-3");
      expect(more[1].id).toBe("root-4");
      expect(more[0].branchIndex).toBe(3);
    });

    it("throws for nonexistent parent", () => {
      createTestExploration();
      expect(() => graph.createChildNodes("test-exp", "nonexistent", 2)).toThrow(
        "Parent node not found"
      );
    });
  });

  describe("getAncestorChain", () => {
    it("returns empty for root", () => {
      createTestExploration();
      expect(graph.getAncestorChain("root")).toEqual([]);
    });

    it("returns ancestors in order (oldest first)", () => {
      createTestExploration();
      graph.createChildNodes("test-exp", "root", 1);
      // Manually complete root-1 so we can add children
      storage.updateNodeContent("root-1", "Child", "content", "test", "test");
      graph.createChildNodes("test-exp", "root-1", 1);

      const ancestors = graph.getAncestorChain("root-1-1");
      expect(ancestors).toHaveLength(2);
      expect(ancestors[0].id).toBe("root");
      expect(ancestors[1].id).toBe("root-1");
    });
  });

  describe("getSiblings", () => {
    it("returns siblings excluding self", () => {
      createTestExploration();
      graph.createChildNodes("test-exp", "root", 3);

      const siblings = graph.getSiblings("root-1");
      expect(siblings).toHaveLength(2);
      expect(siblings.map((s) => s.id)).toContain("root-2");
      expect(siblings.map((s) => s.id)).toContain("root-3");
      expect(siblings.map((s) => s.id)).not.toContain("root-1");
    });

    it("returns empty for root", () => {
      createTestExploration();
      expect(graph.getSiblings("root")).toEqual([]);
    });
  });

  describe("getNodesAtDepth", () => {
    it("returns all nodes at a given depth", () => {
      createTestExploration();
      graph.createChildNodes("test-exp", "root", 3);

      const atDepth1 = graph.getNodesAtDepth("test-exp", 1);
      expect(atDepth1).toHaveLength(3);
      expect(atDepth1.every((n) => n.depth === 1)).toBe(true);
    });

    it("returns empty for depth with no nodes", () => {
      createTestExploration();
      expect(graph.getNodesAtDepth("test-exp", 5)).toEqual([]);
    });
  });

  describe("addCrosslink", () => {
    it("creates a crosslink between nodes", () => {
      createTestExploration();
      graph.createChildNodes("test-exp", "root", 3);

      graph.addCrosslink("root-1", "root-3", "related theme");

      const links = graph.getCrosslinksForNode("root-1");
      expect(links).toHaveLength(1);
      expect(links[0].sourceId).toBe("root-1");
      expect(links[0].targetId).toBe("root-3");
      expect(links[0].label).toBe("related theme");
    });

    it("does not create duplicates (INSERT OR IGNORE)", () => {
      createTestExploration();
      graph.createChildNodes("test-exp", "root", 2);

      graph.addCrosslink("root-1", "root-2");
      graph.addCrosslink("root-1", "root-2"); // duplicate

      const links = graph.getCrosslinksForNode("root-1");
      expect(links).toHaveLength(1);
    });
  });

  describe("pruneNode", () => {
    it("prunes a node and its descendants", () => {
      createTestExploration();
      graph.createChildNodes("test-exp", "root", 2);
      storage.updateNodeContent("root-1", "A", "content", "t", "t");
      graph.createChildNodes("test-exp", "root-1", 2);

      graph.pruneNode("root-1");

      const root1 = graph.getNode("root-1");
      expect(root1!.status).toBe("pruned");
      const child = graph.getNode("root-1-1");
      expect(child!.status).toBe("pruned");
    });
  });

  describe("getConflicts", () => {
    it("returns nodes with content conflicts", () => {
      createTestExploration();
      graph.createChildNodes("test-exp", "root", 2);
      storage.updateNodeContent("root-1", "A", "content", "t", "t");
      storage.setNodeConflict("root-1", "original content");

      const conflicts = graph.getConflicts("test-exp");
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].id).toBe("root-1");
    });
  });
});

describe("Storage", () => {
  describe("close guard", () => {
    it("does not throw on double close", () => {
      storage.close();
      expect(() => storage.close()).not.toThrow();
    });
  });

  describe("getDescendants (CTE)", () => {
    it("returns all descendants efficiently", () => {
      createTestExploration();
      graph.createChildNodes("test-exp", "root", 2);
      storage.updateNodeContent("root-1", "A", "c", "t", "t");
      graph.createChildNodes("test-exp", "root-1", 2);

      const descendants = storage.getDescendants("root");
      // root has 2 children, root-1 has 2 children = 4 descendants
      expect(descendants).toHaveLength(4);
      expect(descendants.map((d) => d.id).sort()).toEqual(
        ["root-1", "root-1-1", "root-1-2", "root-2"].sort()
      );
    });

    it("returns empty for leaf nodes", () => {
      createTestExploration();
      graph.createChildNodes("test-exp", "root", 1);
      expect(storage.getDescendants("root-1")).toEqual([]);
    });
  });

  describe("getNodesByDepth", () => {
    it("queries by depth directly", () => {
      createTestExploration();
      graph.createChildNodes("test-exp", "root", 3);

      const nodes = storage.getNodesByDepth("test-exp", 1);
      expect(nodes).toHaveLength(3);
    });
  });

  describe("updateNodeContent returns updated node", () => {
    it("returns the node after update", () => {
      createTestExploration();
      graph.createChildNodes("test-exp", "root", 1);

      const updated = storage.updateNodeContent(
        "root-1", "New Title", "New content", "claude", "bedrock"
      );
      expect(updated.title).toBe("New Title");
      expect(updated.content).toBe("New content");
      expect(updated.status).toBe("complete");
    });
  });

  describe("updateNodeStatus returns updated node", () => {
    it("returns the node after status change", () => {
      createTestExploration();
      graph.createChildNodes("test-exp", "root", 1);

      const updated = storage.updateNodeStatus("root-1", "generating");
      expect(updated.status).toBe("generating");
    });
  });

  describe("node annotations", () => {
    it("creates and retrieves node annotations", () => {
      createTestExploration();

      storage.createNodeAnnotation({
        id: "na-1",
        nodeId: "root",
        content: "This is a note",
        source: "synthesis",
        synthesisAnnotationId: null,
        createdAt: nowISO(),
      });

      const annotations = storage.getNodeAnnotations("root");
      expect(annotations).toHaveLength(1);
      expect(annotations[0].content).toBe("This is a note");
    });

    it("deletes annotations", () => {
      createTestExploration();
      storage.createNodeAnnotation({
        id: "na-1",
        nodeId: "root",
        content: "note",
        source: "user",
        synthesisAnnotationId: null,
        createdAt: nowISO(),
      });

      storage.deleteNodeAnnotation("na-1");
      expect(storage.getNodeAnnotations("root")).toHaveLength(0);
    });
  });

  describe("crosslinks", () => {
    it("getCrosslinksForExploration finds links in both directions", () => {
      createTestExploration();
      graph.createChildNodes("test-exp", "root", 3);
      graph.addCrosslink("root-1", "root-3", "link A");
      graph.addCrosslink("root-2", "root-3", "link B");

      const links = storage.getCrosslinksForExploration("test-exp");
      expect(links).toHaveLength(2);
    });
  });

  describe("transaction", () => {
    it("rolls back on error", () => {
      createTestExploration();
      graph.createChildNodes("test-exp", "root", 1);

      try {
        storage.transaction(() => {
          storage.updateNodeStatus("root-1", "generating");
          throw new Error("rollback");
        });
      } catch {}

      const node = storage.getNode("root-1");
      expect(node!.status).toBe("pending"); // rolled back
    });
  });
});
