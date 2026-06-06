import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import { Storage } from "../src/storage.js";
import { Graph } from "../src/graph.js";
import type { AgentProvider, GenerateRequest, GenerateResponse, PlanRequest, PlanResponse } from "@lain/shared";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

class MockAgent implements AgentProvider {
  gen = 0;
  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    this.gen++;
    return { title: `T ${request.node.id}`, content: `C ${request.node.id}`, model: "mock", provider: "anthropic" };
  }
  async generateStream(request: GenerateRequest, onChunk: (c: string) => void): Promise<GenerateResponse> {
    const r = await this.generate(request);
    onChunk(r.content);
    return r;
  }
  async plan(request: PlanRequest): Promise<PlanResponse> {
    return { directions: Array.from({ length: request.n }, (_, i) => `dir ${i + 1}`) };
  }
}

let tmp: string;
let dbPath: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lain-resume-"));
  dbPath = path.join(tmp, "t.db");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("resume", () => {
  it("regenerates pending nodes and is idempotent", async () => {
    const agent = new MockAgent();
    const orch = new Orchestrator({ dbPath, agent });
    await orch.explore({ id: "e", name: "n", seed: "s", n: 2, m: 2, strategy: "bf", planDetail: "sentence", extension: "freeform" });

    // Simulate an interruption: two nodes left pending.
    const storage = orch.getStorage();
    storage.updateNodeStatus("root-1-1", "pending");
    storage.updateNodeStatus("root-2-2", "pending");
    agent.gen = 0;

    const r1 = await orch.resume("e");
    expect(r1.generated).toBe(2);
    expect(agent.gen).toBe(2); // only the two pending nodes regenerated
    const g = orch.getGraph();
    expect(g.getNode("root-1-1")!.status).toBe("complete");
    expect(g.getNode("root-2-2")!.status).toBe("complete");

    // Idempotent: nothing left to do.
    const r2 = await orch.resume("e");
    expect(r2).toEqual({ generated: 0, created: 0 });
    orch.close();
  });

  it("builds missing children from a bare root", async () => {
    const agent = new MockAgent();
    const orch = new Orchestrator({ dbPath, agent });
    // Only the (complete) root exists — as if the run died before any children.
    orch.getGraph().createExploration({ id: "e", name: "n", seed: "s", n: 2, m: 2, strategy: "bf", planDetail: "sentence", extension: "freeform" });

    const { generated, created } = await orch.resume("e");
    expect(created).toBe(6);   // 2 at depth1 + 4 at depth2
    expect(generated).toBe(6);

    const nodes = orch.getGraph().getAllNodes("e");
    expect(nodes).toHaveLength(7);
    expect(nodes.every((n) => n.status === "complete")).toBe(true);
    orch.close();
  });
});
