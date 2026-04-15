import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import { Exporter } from "../src/export.js";
import { Sync } from "../src/sync.js";
import { Storage } from "../src/storage.js";
import { Graph } from "../src/graph.js";
import type {
  AgentProvider,
  GenerateRequest,
  GenerateResponse,
  PlanRequest,
  PlanResponse,
  LainEvent,
} from "@lain/shared";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import matter from "gray-matter";

// Mock agent that generates deterministic content
class MockAgent implements AgentProvider {
  callCount = 0;

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    this.callCount++;
    const direction = request.node.planSummary || "general exploration";
    return {
      title: `Node ${request.node.id}: ${direction.slice(0, 30)}`,
      content: `This explores "${direction}" branching from "${request.ancestors.at(-1)?.title || "root"}".\n\nDepth: ${request.node.depth}, Branch: ${request.node.branchIndex}.\n\nSiblings already exploring: ${request.siblings.map((s) => s.title).join(", ") || "none"}.`,
    };
  }

  async generateStream(
    request: GenerateRequest,
    onChunk: (chunk: string) => void
  ): Promise<GenerateResponse> {
    const result = await this.generate(request);
    onChunk(result.title + "\n" + result.content);
    return result;
  }

  async plan(request: PlanRequest): Promise<PlanResponse> {
    const directions: string[] = [];
    for (let i = 0; i < request.n; i++) {
      directions.push(
        `Direction ${i + 1} from "${request.parentNode.title || "root"}"`
      );
    }
    return { directions };
  }
}

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lain-e2e-"));
  dbPath = path.join(tmpDir, "test.db");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("End-to-end exploration", () => {
  it("generates a full tree with n=2, m=2", async () => {
    const events: LainEvent[] = [];
    const agent = new MockAgent();

    const orchestrator = new Orchestrator({
      dbPath,
      agent,
      onEvent: (e) => events.push(e),
    });

    const exploration = await orchestrator.explore({
      id: "e2e-test",
      name: "E2E Test",
      seed: "What if AI could dream?",
      n: 2,
      m: 2,
      strategy: "bf",
      planDetail: "sentence",
      extension: "freeform",
    });

    expect(exploration.id).toBe("e2e-test");

    // Should have: root + 2 children + 4 grandchildren = 7 nodes total
    const graph = orchestrator.getGraph();
    const nodes = graph.getAllNodes("e2e-test");
    expect(nodes).toHaveLength(7);

    // Root should be complete
    const root = graph.getNode("root")!;
    expect(root.status).toBe("complete");
    expect(root.depth).toBe(0);

    // All non-root nodes should be complete
    const nonRoot = nodes.filter((n) => n.id !== "root");
    for (const node of nonRoot) {
      expect(node.status).toBe("complete");
      expect(node.title).toBeTruthy();
      expect(node.content).toBeTruthy();
    }

    // Verify depth structure
    const depths = nodes.reduce(
      (acc, n) => {
        acc[n.depth] = (acc[n.depth] || 0) + 1;
        return acc;
      },
      {} as Record<number, number>
    );
    expect(depths[0]).toBe(1); // root
    expect(depths[1]).toBe(2); // 2 children
    expect(depths[2]).toBe(4); // 4 grandchildren

    // Agent should have been called for plans + generations
    // Plans: 1 (root) + 2 (children) = 3 plan calls
    // Generates: 2 (children) + 4 (grandchildren) = 6 generate calls
    expect(agent.callCount).toBe(6);

    // Events should have been emitted
    expect(events.some((e) => e.type === "exploration:created")).toBe(true);
    expect(events.some((e) => e.type === "exploration:complete")).toBe(true);
    expect(events.filter((e) => e.type === "node:complete")).toHaveLength(6);

    orchestrator.close();
  });

  it("generates with depth-first strategy", async () => {
    const agent = new MockAgent();

    const orchestrator = new Orchestrator({
      dbPath,
      agent,
    });

    await orchestrator.explore({
      id: "df-test",
      name: "DF Test",
      seed: "Depth first exploration",
      n: 2,
      m: 2,
      strategy: "df",
      planDetail: "brief",
      extension: "freeform",
    });

    const graph = orchestrator.getGraph();
    const nodes = graph.getAllNodes("df-test");
    expect(nodes).toHaveLength(7);

    orchestrator.close();
  });

  it("extends a node with additional children", async () => {
    const agent = new MockAgent();

    const orchestrator = new Orchestrator({
      dbPath,
      agent,
    });

    await orchestrator.explore({
      id: "extend-test",
      name: "Extend Test",
      seed: "A seed idea",
      n: 2,
      m: 1, // Only 1 level deep initially
      strategy: "bf",
      planDetail: "sentence",
      extension: "freeform",
    });

    // Should have root + 2 children = 3 nodes
    let graph = orchestrator.getGraph();
    expect(graph.getAllNodes("extend-test")).toHaveLength(3);

    // Extend root-1 with 3 more children
    const newNodes = await orchestrator.extendNode("extend-test", "root-1", 3);
    expect(newNodes).toHaveLength(3);
    expect(newNodes[0].id).toBe("root-1-1");
    expect(newNodes[2].id).toBe("root-1-3");

    // Now should have 6 nodes total
    expect(graph.getAllNodes("extend-test")).toHaveLength(6);

    orchestrator.close();
  });

  it("full pipeline: explore -> export -> edit -> sync round-trip", async () => {
    const agent = new MockAgent();

    // Step 1: Generate exploration
    const orchestrator = new Orchestrator({
      dbPath,
      agent,
    });

    await orchestrator.explore({
      id: "pipeline-test",
      name: "Pipeline Test",
      seed: "Round trip test",
      n: 2,
      m: 1,
      strategy: "bf",
      planDetail: "sentence",
      extension: "freeform",
    });

    orchestrator.close();

    // Step 2: Export via sync push
    const outputDir = path.join(tmpDir, "obsidian");
    const storage = new Storage(dbPath);
    const sync = new Sync(storage);
    const pushResult = sync.push("pipeline-test", outputDir);

    expect(pushResult.pushed.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(outputDir, "root.md"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "root-1.md"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "root-2.md"))).toBe(true);

    // Step 3: Edit a file (simulate agent/human edit)
    const filePath = path.join(outputDir, "root-1.md");
    const original = fs.readFileSync(filePath, "utf-8");
    const edited = original.replace(
      /This explores .*/,
      "AGENT EDITED: This is a new insight about the direction."
    );
    fs.writeFileSync(filePath, edited);

    // Step 4: Sync pull — should detect the edit
    const pullResult = sync.pull("pipeline-test", outputDir);
    expect(pullResult.pulled).toContain("root-1");

    // Step 5: Verify db has the new content
    const graph = new Graph(storage);
    const node = graph.getNode("root-1")!;
    expect(node.content).toContain("AGENT EDITED");

    // Step 6: Full bidirectional sync should be clean now
    const syncResult = sync.sync("pipeline-test", outputDir);
    // Everything should be pushed (db was updated, files need refresh)
    // but no conflicts
    expect(syncResult.conflicts).toHaveLength(0);

    storage.close();
  });

  it("handles plan detail = none (skip planning)", async () => {
    const agent = new MockAgent();

    const orchestrator = new Orchestrator({
      dbPath,
      agent,
    });

    await orchestrator.explore({
      id: "noplan-test",
      name: "No Plan Test",
      seed: "Skip planning",
      n: 2,
      m: 1,
      strategy: "bf",
      planDetail: "none",
      extension: "freeform",
    });

    const graph = orchestrator.getGraph();
    const nodes = graph.getAllNodes("noplan-test");
    expect(nodes).toHaveLength(3);

    // Children should have no plan summary
    const children = nodes.filter((n) => n.depth === 1);
    for (const child of children) {
      expect(child.planSummary).toBeNull();
    }

    orchestrator.close();
  });
});
