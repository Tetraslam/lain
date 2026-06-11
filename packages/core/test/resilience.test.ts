import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import { Storage } from "../src/storage.js";
import { Graph } from "../src/graph.js";
import type { AgentProvider, ConverseRequest, ConverseResult, PlanRequest, PlanResponse, LainEvent } from "@lain/shared";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseNodeId, submitNodeTurn } from "./_agentmock.js";

// Agent that throws when generating one specific node, succeeds for the rest —
// to prove a single node's failure doesn't sink its siblings or the run.
class FlakyAgent implements AgentProvider {
  constructor(private failNodeId: string) {}
  async converse(request: ConverseRequest): Promise<ConverseResult> {
    const id = parseNodeId(request.messages);
    if (id === this.failNodeId) throw new Error(`boom on ${id}`);
    return submitNodeTurn(`Node ${id}`, `Content for node ${id}.`);
  }
  async generate(): Promise<never> { throw new Error("not used"); }
  async generateStream(): Promise<never> { throw new Error("not used"); }
  async plan(request: PlanRequest): Promise<PlanResponse> {
    return { directions: Array.from({ length: request.n }, (_, i) => `Direction ${i + 1}`) };
  }
}

let tmpDir: string;
let dbPath: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lain-resil-")); dbPath = path.join(tmpDir, "t.db"); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe("per-node failure isolation", () => {
  it("a single failing node stays pending while siblings complete (BF)", async () => {
    const events: LainEvent[] = [];
    const orch = new Orchestrator({ dbPath, agent: new FlakyAgent("root-2"), onEvent: (e) => events.push(e) });

    // Should NOT throw even though root-2 fails.
    await orch.explore({
      id: "x", name: "x", seed: "seed", n: 3, m: 1,
      strategy: "bf", planDetail: "sentence", extension: "freeform",
    });

    const g = orch.getGraph();
    expect(g.getNode("root")!.status).toBe("complete");
    expect(g.getNode("root-2")!.status).toBe("pending"); // failed → resumable
    expect(g.getNode("root-1")!.status).toBe("complete");
    expect(g.getNode("root-3")!.status).toBe("complete");

    // The failure was surfaced as an error event naming the node.
    const errs = events.filter((e) => e.type === "error" && e.nodeId === "root-2");
    expect(errs.length).toBeGreaterThan(0);
  });

  it("resume completes the previously-failed node", async () => {
    const orch = new Orchestrator({ dbPath, agent: new FlakyAgent("root-2"), onEvent: () => {} });
    await orch.explore({ id: "x", name: "x", seed: "seed", n: 3, m: 1, strategy: "bf", planDetail: "sentence", extension: "freeform" });
    expect(orch.getGraph().getNode("root-2")!.status).toBe("pending");

    // A healthy agent + resume should finish it.
    const orch2 = new Orchestrator({ dbPath, agent: new FlakyAgent("none"), onEvent: () => {} });
    await orch2.resume("x");
    expect(orch2.getGraph().getNode("root-2")!.status).toBe("complete");
  });
});

describe("getAncestors", () => {
  it("returns the chain oldest-first via a single CTE", () => {
    const s = new Storage(dbPath);
    const g = new Graph(s);
    g.createExploration({ id: "x", name: "root", seed: "root", n: 2, m: 3, strategy: "bf", planDetail: "sentence", extension: "freeform" });
    // Build root → root-1 → root-1-1 by hand.
    const c1 = g.createChildNodes("x", "root", 1)[0];
    s.updateNodeStatus(c1.id, "complete");
    const c2 = g.createChildNodes("x", c1.id, 1)[0];
    s.updateNodeStatus(c2.id, "complete");

    const anc = s.getAncestors(c2.id).map((n) => n.id);
    expect(anc).toEqual(["root", c1.id]); // oldest-first, excludes the node itself
    expect(s.getAncestors("root")).toEqual([]); // root has none
    s.close();
  });
});
