import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Storage } from "../src/storage.js";
import { Graph } from "../src/graph.js";
import { CanvasExporter } from "../src/canvas-export.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { nowISO } from "@lain/shared";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lain-canvas-test-"));
  dbPath = path.join(tmpDir, "test.db");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Helper: create an exploration with a given tree shape and return storage + graph.
 */
function createExploration(
  n: number,
  m: number,
  opts?: { crosslinks?: [string, string, string?][] }
) {
  const storage = new Storage(dbPath);
  const graph = new Graph(storage);

  graph.createExploration({
    id: "exp-1",
    name: "Test Exploration",
    seed: "What if trees could talk?",
    n,
    m,
    strategy: "bf",
    planDetail: "sentence",
    extension: "freeform",
  });

  // Generate the tree to depth m
  function expandNode(parentId: string, currentDepth: number) {
    if (currentDepth >= m) return;
    const children = graph.createChildNodes("exp-1", parentId, n);
    for (const child of children) {
      storage.updateNodeContent(
        child.id,
        `Title of ${child.id}`,
        `Content for node ${child.id} at depth ${child.depth}`,
        "test-model",
        "anthropic"
      );
      expandNode(child.id, currentDepth + 1);
    }
  }
  expandNode("root", 0);

  // Add crosslinks if specified
  if (opts?.crosslinks) {
    for (const [source, target, label] of opts.crosslinks) {
      graph.addCrosslink(source, target, label);
    }
  }

  return { storage, graph };
}

describe("CanvasExporter", () => {
  describe("buildCanvas", () => {
    it("creates valid canvas JSON for a single root node", () => {
      const storage = new Storage(dbPath);
      const graph = new Graph(storage);

      graph.createExploration({
        id: "exp-1",
        name: "Solo Root",
        seed: "A lonely idea",
        n: 3,
        m: 0,
        strategy: "bf",
        planDetail: "none",
        extension: "freeform",
      });

      const exporter = new CanvasExporter(storage);
      const nodes = graph.getAllNodes("exp-1");
      const crosslinks = graph.getCrosslinks("exp-1");
      const canvas = exporter.buildCanvas(nodes, crosslinks);

      expect(canvas.nodes).toHaveLength(1);
      expect(canvas.edges).toHaveLength(0);

      const rootNode = canvas.nodes[0];
      expect(rootNode.type).toBe("text");
      expect(rootNode.id).toBe("root");
      expect(rootNode.text).toContain("Solo Root");
      expect(rootNode.text).toContain("A lonely idea");
      expect(rootNode.color).toBe("6"); // purple for root
      expect(rootNode.width).toBe(400);
      expect(rootNode.height).toBe(200);

      storage.close();
    });

    it("creates correct tree structure for n=3, m=1", () => {
      const { storage } = createExploration(3, 1);
      const graph = new Graph(storage);
      const exporter = new CanvasExporter(storage);

      const nodes = graph.getAllNodes("exp-1");
      const crosslinks = graph.getCrosslinks("exp-1");
      const canvas = exporter.buildCanvas(nodes, crosslinks);

      // 1 root + 3 children = 4 nodes
      expect(canvas.nodes).toHaveLength(4);
      // 3 tree edges (root → each child)
      expect(canvas.edges).toHaveLength(3);

      // Root is text node
      const rootNode = canvas.nodes.find((n) => n.id === "root");
      expect(rootNode).toBeDefined();
      expect(rootNode!.type).toBe("text");

      // Children are text nodes with titles
      const childNodes = canvas.nodes.filter((n) => n.id !== "root");
      expect(childNodes).toHaveLength(3);
      for (const cn of childNodes) {
        expect(cn.type).toBe("text");
        expect(cn.text).toContain("**Title of");
        expect(cn.text).toContain("open note");
      }

      // All edges point from root to children
      for (const edge of canvas.edges) {
        expect(edge.fromNode).toBe("root");
        expect(edge.toEnd).toBe("arrow");
        expect(edge.fromEnd).toBe("none");
      }

      storage.close();
    });

    it("creates correct tree structure for n=2, m=2", () => {
      const { storage } = createExploration(2, 2);
      const graph = new Graph(storage);
      const exporter = new CanvasExporter(storage);

      const nodes = graph.getAllNodes("exp-1");
      const crosslinks = graph.getCrosslinks("exp-1");
      const canvas = exporter.buildCanvas(nodes, crosslinks);

      // 1 root + 2 depth-1 + 4 depth-2 = 7 nodes
      expect(canvas.nodes).toHaveLength(7);
      // 6 tree edges
      expect(canvas.edges).toHaveLength(6);

      // Check depth-based colors
      const root = canvas.nodes.find((n) => n.id === "root");
      expect(root!.color).toBe("6"); // purple

      const depth1 = canvas.nodes.filter((n) =>
        n.id === "root-1" || n.id === "root-2"
      );
      for (const d1 of depth1) {
        expect(d1.color).toBe("5"); // cyan
      }

      const depth2 = canvas.nodes.filter((n) =>
        n.id.match(/^root-\d+-\d+$/)
      );
      for (const d2 of depth2) {
        expect(d2.color).toBe("4"); // green
      }

      storage.close();
    });

    it("handles crosslinks with bidirectional arrows and orange color", () => {
      const { storage } = createExploration(3, 1, {
        crosslinks: [["root-1", "root-3", "related concepts"]],
      });
      const graph = new Graph(storage);
      const exporter = new CanvasExporter(storage);

      const nodes = graph.getAllNodes("exp-1");
      const crosslinks = graph.getCrosslinks("exp-1");
      const canvas = exporter.buildCanvas(nodes, crosslinks);

      // 3 tree edges + 1 crosslink = 4 edges
      expect(canvas.edges).toHaveLength(4);

      const crosslinkEdge = canvas.edges.find((e) =>
        e.id.startsWith("crosslink-")
      );
      expect(crosslinkEdge).toBeDefined();
      expect(crosslinkEdge!.fromNode).toBe("root-1");
      expect(crosslinkEdge!.toNode).toBe("root-3");
      expect(crosslinkEdge!.fromEnd).toBe("arrow"); // bidirectional
      expect(crosslinkEdge!.toEnd).toBe("arrow");
      expect(crosslinkEdge!.color).toBe("2"); // orange
      expect(crosslinkEdge!.label).toBe("related concepts");

      storage.close();
    });

    it("excludes pruned nodes from canvas", () => {
      const { storage, graph } = createExploration(3, 1);
      graph.pruneNode("root-2");

      const exporter = new CanvasExporter(storage);
      const nodes = graph.getAllNodes("exp-1").filter((n) => n.status !== "pruned");
      const crosslinks = graph.getCrosslinks("exp-1");
      const canvas = exporter.buildCanvas(nodes, crosslinks);

      // 1 root + 2 remaining children = 3 nodes
      expect(canvas.nodes).toHaveLength(3);
      expect(canvas.nodes.find((n) => n.id === "root-2")).toBeUndefined();

      storage.close();
    });

    it("generates unique IDs for all nodes and edges", () => {
      const { storage } = createExploration(3, 2);
      const graph = new Graph(storage);
      const exporter = new CanvasExporter(storage);

      const nodes = graph.getAllNodes("exp-1");
      const crosslinks = graph.getCrosslinks("exp-1");
      const canvas = exporter.buildCanvas(nodes, crosslinks);

      const nodeIds = canvas.nodes.map((n) => n.id);
      const edgeIds = canvas.edges.map((e) => e.id);
      const allIds = [...nodeIds, ...edgeIds];

      expect(new Set(allIds).size).toBe(allIds.length);

      storage.close();
    });

    it("all edge references point to existing nodes", () => {
      const { storage } = createExploration(3, 2, {
        crosslinks: [["root-1-1", "root-2-1"]],
      });
      const graph = new Graph(storage);
      const exporter = new CanvasExporter(storage);

      const nodes = graph.getAllNodes("exp-1");
      const crosslinks = graph.getCrosslinks("exp-1");
      const canvas = exporter.buildCanvas(nodes, crosslinks);

      const nodeIds = new Set(canvas.nodes.map((n) => n.id));
      for (const edge of canvas.edges) {
        expect(nodeIds.has(edge.fromNode)).toBe(true);
        expect(nodeIds.has(edge.toNode)).toBe(true);
      }

      storage.close();
    });

    it("uses mdFolderRel in wikilink paths", () => {
      const { storage } = createExploration(2, 1);
      const graph = new Graph(storage);
      const exporter = new CanvasExporter(storage);

      const nodes = graph.getAllNodes("exp-1");
      const crosslinks = graph.getCrosslinks("exp-1");
      const canvas = exporter.buildCanvas(nodes, crosslinks, "my-exploration");

      const childNodes = canvas.nodes.filter((n) => n.id !== "root");
      for (const cn of childNodes) {
        expect(cn.text).toContain("my-exploration/");
      }

      storage.close();
    });
  });

  describe("radial layout", () => {
    it("places root at center (accounting for node dimensions)", () => {
      const { storage } = createExploration(3, 1);
      const graph = new Graph(storage);
      const exporter = new CanvasExporter(storage);

      const nodes = graph.getAllNodes("exp-1");
      const crosslinks = graph.getCrosslinks("exp-1");
      const canvas = exporter.buildCanvas(nodes, crosslinks);

      const root = canvas.nodes.find((n) => n.id === "root")!;
      // Root's x,y is top-left corner, centered means x = -width/2, y = -height/2
      expect(root.x).toBe(-200); // -400/2
      expect(root.y).toBe(-100); // -200/2

      storage.close();
    });

    it("places children at equal radius from center", () => {
      const { storage } = createExploration(4, 1);
      const graph = new Graph(storage);
      const exporter = new CanvasExporter(storage);

      const nodes = graph.getAllNodes("exp-1");
      const crosslinks = graph.getCrosslinks("exp-1");
      const canvas = exporter.buildCanvas(nodes, crosslinks);

      // Get child center positions
      const children = canvas.nodes.filter((n) => n.id !== "root");
      const distances = children.map((c) => {
        const cx = c.x + c.width / 2;
        const cy = c.y + c.height / 2;
        return Math.sqrt(cx * cx + cy * cy);
      });

      // All children should be at roughly the same radius
      const avgDist = distances.reduce((a, b) => a + b, 0) / distances.length;
      for (const d of distances) {
        expect(Math.abs(d - avgDist)).toBeLessThan(5); // within 5px
      }

      storage.close();
    });

    it("no nodes overlap each other", () => {
      const { storage } = createExploration(5, 2);
      const graph = new Graph(storage);
      const exporter = new CanvasExporter(storage);

      const nodes = graph.getAllNodes("exp-1");
      const crosslinks = graph.getCrosslinks("exp-1");
      const canvas = exporter.buildCanvas(nodes, crosslinks);

      // Check all pairs for overlap
      for (let i = 0; i < canvas.nodes.length; i++) {
        for (let j = i + 1; j < canvas.nodes.length; j++) {
          const a = canvas.nodes[i];
          const b = canvas.nodes[j];
          const overlapX =
            a.x < b.x + b.width && a.x + a.width > b.x;
          const overlapY =
            a.y < b.y + b.height && a.y + a.height > b.y;
          if (overlapX && overlapY) {
            // This is acceptable only if one is a group containing the other
            // Since we don't use groups, this should never happen
            expect(
              `${a.id} overlaps ${b.id}`
            ).toBe("no overlap expected");
          }
        }
      }

      storage.close();
    });

    it("deeper nodes are farther from center", () => {
      const { storage } = createExploration(2, 3);
      const graph = new Graph(storage);
      const exporter = new CanvasExporter(storage);

      const nodes = graph.getAllNodes("exp-1");
      const allLain = graph.getAllNodes("exp-1");
      const crosslinks = graph.getCrosslinks("exp-1");
      const canvas = exporter.buildCanvas(nodes, crosslinks);

      // Build a depth map from lain nodes
      const depthOf = new Map<string, number>();
      for (const n of allLain) depthOf.set(n.id, n.depth);

      // Group canvas nodes by depth and compute avg distance
      const distByDepth = new Map<number, number[]>();
      for (const cn of canvas.nodes) {
        const depth = depthOf.get(cn.id) ?? 0;
        const cx = cn.x + cn.width / 2;
        const cy = cn.y + cn.height / 2;
        const dist = Math.sqrt(cx * cx + cy * cy);
        if (!distByDepth.has(depth)) distByDepth.set(depth, []);
        distByDepth.get(depth)!.push(dist);
      }

      const avgByDepth = new Map<number, number>();
      for (const [depth, dists] of distByDepth) {
        avgByDepth.set(depth, dists.reduce((a, b) => a + b, 0) / dists.length);
      }

      // Each deeper ring should be farther out
      const depths = [...avgByDepth.keys()].sort((a, b) => a - b);
      for (let i = 1; i < depths.length; i++) {
        expect(avgByDepth.get(depths[i])!).toBeGreaterThan(
          avgByDepth.get(depths[i - 1])!
        );
      }

      storage.close();
    });
  });

  describe("export to file", () => {
    it("writes a valid .canvas JSON file", () => {
      const { storage } = createExploration(2, 1);
      const canvasPath = path.join(tmpDir, "test.canvas");

      const exporter = new CanvasExporter(storage);
      exporter.export("exp-1", canvasPath);

      expect(fs.existsSync(canvasPath)).toBe(true);

      const content = fs.readFileSync(canvasPath, "utf-8");
      const parsed = JSON.parse(content);

      expect(parsed.nodes).toBeDefined();
      expect(parsed.edges).toBeDefined();
      expect(Array.isArray(parsed.nodes)).toBe(true);
      expect(Array.isArray(parsed.edges)).toBe(true);

      storage.close();
    });

    it("creates parent directories if needed", () => {
      const { storage } = createExploration(2, 1);
      const canvasPath = path.join(tmpDir, "nested", "deep", "test.canvas");

      const exporter = new CanvasExporter(storage);
      exporter.export("exp-1", canvasPath);

      expect(fs.existsSync(canvasPath)).toBe(true);

      storage.close();
    });

    it("throws for non-existent exploration", () => {
      const storage = new Storage(dbPath);
      const exporter = new CanvasExporter(storage);

      expect(() =>
        exporter.export("nonexistent", path.join(tmpDir, "out.canvas"))
      ).toThrow("Exploration not found");

      storage.close();
    });

    it("wikilink paths use mdFolderRel when provided", () => {
      const { storage } = createExploration(2, 1);
      const canvasPath = path.join(tmpDir, "test.canvas");

      const exporter = new CanvasExporter(storage);
      exporter.export("exp-1", canvasPath, "my-notes");

      const content = fs.readFileSync(canvasPath, "utf-8");
      const parsed = JSON.parse(content);

      const childNodes = parsed.nodes.filter(
        (n: any) => n.id !== "root"
      );
      for (const cn of childNodes) {
        expect(cn.text).toContain("my-notes/");
      }

      storage.close();
    });
  });

  describe("edge cases", () => {
    it("handles large branching factor n=8, m=1", () => {
      const { storage } = createExploration(8, 1);
      const graph = new Graph(storage);
      const exporter = new CanvasExporter(storage);

      const nodes = graph.getAllNodes("exp-1");
      const crosslinks = graph.getCrosslinks("exp-1");
      const canvas = exporter.buildCanvas(nodes, crosslinks);

      expect(canvas.nodes).toHaveLength(9); // 1 + 8
      expect(canvas.edges).toHaveLength(8);

      storage.close();
    });

    it("handles deep linear tree n=1, m=5", () => {
      const { storage } = createExploration(1, 5);
      const graph = new Graph(storage);
      const exporter = new CanvasExporter(storage);

      const nodes = graph.getAllNodes("exp-1");
      const crosslinks = graph.getCrosslinks("exp-1");
      const canvas = exporter.buildCanvas(nodes, crosslinks);

      expect(canvas.nodes).toHaveLength(6); // root + 5 nodes
      expect(canvas.edges).toHaveLength(5);

      storage.close();
    });

    it("crosslink to pruned node is excluded", () => {
      const { storage, graph } = createExploration(3, 1, {
        crosslinks: [["root-1", "root-3"]],
      });

      // Prune the target of the crosslink
      graph.pruneNode("root-3");

      const exporter = new CanvasExporter(storage);
      const nodes = graph.getAllNodes("exp-1").filter((n) => n.status !== "pruned");
      const crosslinks = graph.getCrosslinks("exp-1");
      const canvas = exporter.buildCanvas(nodes, crosslinks);

      // The crosslink edge should be absent because root-3 is pruned
      const clEdge = canvas.edges.find((e) => e.id.startsWith("crosslink-"));
      expect(clEdge).toBeUndefined();

      storage.close();
    });
  });
});
