import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Storage } from "../src/storage.js";
import { Graph } from "../src/graph.js";
import { Orchestrator } from "../src/orchestrator.js";
import { parseContract } from "../src/mission.js";
import { buildNodeTools, buildToolContext } from "../src/tools.js";
import type { AgentProvider, GenerateRequest, GenerateResponse, PlanRequest, PlanResponse } from "@lain/shared";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("parseContract (back-compat shim)", () => {
  it("extracts intent + criteria from assertion JSON", () => {
    const r = parseContract('prefix {"intent":"go deep","assertions":[{"id":"A1","text":"a"},{"id":"A2","text":"b"}]} suffix');
    expect(r.intent).toBe("go deep");
    expect(r.criteria).toEqual(["a", "b"]);
  });
  it("returns empty on malformed input", () => {
    expect(parseContract("no json here")).toEqual({ intent: "", criteria: [] });
  });
});

describe("Mission storage", () => {
  let tmp: string;
  let storage: Storage;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lain-mission-"));
    storage = new Storage(path.join(tmp, "t.db"));
    new Graph(storage).createExploration({ id: "e", name: "n", seed: "s", n: 2, m: 1, strategy: "bf", planDetail: "sentence", extension: "freeform" });
  });
  afterEach(() => { storage.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it("upserts a contract + features and reads them back", () => {
    storage.upsertMission({
      explorationId: "e", intent: "the goal",
      assertions: [{ id: "A1", text: "x" }, { id: "A2", text: "y" }],
      features: [{ id: "F1", angle: "angle one", assertions: ["A1"] }],
      createdAt: new Date().toISOString(),
    });
    const m = storage.getMission("e")!;
    expect(m.intent).toBe("the goal");
    expect(m.assertions.map((a) => a.id)).toEqual(["A1", "A2"]);
    expect(m.features[0].angle).toBe("angle one");
  });

  it("stores mission reports per round", () => {
    storage.addMissionReport({ explorationId: "e", round: 0, satisfied: false, results: [{ id: "A1", status: "unmet", evidence: "" }], summary: "gap", createdAt: new Date().toISOString() });
    storage.addMissionReport({ explorationId: "e", round: 1, satisfied: true, results: [{ id: "A1", status: "met", evidence: "root-3" }], summary: "complete", createdAt: new Date().toISOString() });
    expect(storage.getMissionReports("e")).toHaveLength(2);
    const latest = storage.getLatestMissionReport("e")!;
    expect(latest.round).toBe(1);
    expect(latest.satisfied).toBe(true);
  });
});

// A mock agent that returns canned JSON per role (detected via the system text)
// and deterministic node content. The validator reports A1 unmet on the first
// pass, then everything met after a fix — exercising the autonomous fix loop.
class MockMissionAgent implements AgentProvider {
  validateCalls = 0;
  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    return { title: `T ${request.node.id}`, content: `C ${request.node.id}: ${request.node.planSummary ?? ""}`, model: "mock", provider: "anthropic" };
  }
  async generateStream(request: GenerateRequest, onChunk: (c: string) => void): Promise<GenerateResponse> {
    const r = await this.generate(request); onChunk(r.content); return r;
  }
  async plan(request: PlanRequest): Promise<PlanResponse> {
    return { directions: Array.from({ length: request.n }, (_, i) => `dir ${i + 1}`) };
  }
  async generateRaw(system: string, _user: string): Promise<string> {
    if (system.includes("VALIDATION CONTRACT")) {
      return '{"intent":"deep goal","assertions":[{"id":"A1","text":"covers risk"},{"id":"A2","text":"covers benefit"}]}';
    }
    if (system.includes("decomposing a mission into FEATURES")) {
      return '{"features":[{"id":"F1","angle":"the risks","assertions":["A1"]},{"id":"F2","angle":"the benefits","assertions":["A2"]}]}';
    }
    if (system.includes("independent validator")) {
      this.validateCalls++;
      if (this.validateCalls === 1) {
        return '{"results":[{"id":"A1","status":"unmet","evidence":""},{"id":"A2","status":"met","evidence":"root-2"}],"summary":"risk not covered"}';
      }
      return '{"results":[{"id":"A1","status":"met","evidence":"root-3"},{"id":"A2","status":"met","evidence":"root-2"}],"summary":"complete"}';
    }
    if (system.includes("orchestrator of an ideation mission")) {
      return '{"fixes":[{"parent":"root","angle":"explore the risks directly","assertions":["A1"]}]}';
    }
    return "{}";
  }
}

describe("mission lifecycle (plan → validate → fix → revalidate)", () => {
  let tmp: string;
  let dbPath: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lain-mlife-")); dbPath = path.join(tmp, "t.db"); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("pursueMission closes an unmet assertion and converges", async () => {
    const agent = new MockMissionAgent();
    const orch = new Orchestrator({ dbPath, agent });
    await orch.explore({ id: "e", name: "n", seed: "a hard problem", n: 2, m: 1, strategy: "bf", planDetail: "sentence", extension: "freeform" });

    const storage = orch.getStorage();
    storage.upsertMission({
      explorationId: "e", intent: "deep goal",
      assertions: [{ id: "A1", text: "covers risk" }, { id: "A2", text: "covers benefit" }],
      features: [],
      createdAt: new Date().toISOString(),
    });

    const before = orch.getGraph().getAllNodes("e").length;
    const report = await orch.pursueMission("e", { maxRounds: 2 });
    expect(report).not.toBeNull();
    expect(report!.satisfied).toBe(true);          // converged
    expect(report!.round).toBe(1);                 // one fix round
    expect(agent.validateCalls).toBe(2);           // initial + after fix

    // A fix branch was generated, and two reports were recorded.
    expect(orch.getGraph().getAllNodes("e").length).toBeGreaterThan(before);
    expect(storage.getMissionReports("e")).toHaveLength(2);
    orch.close();
  });
});

describe("findings tools", () => {
  let tmp: string;
  let storage: Storage;
  let graph: Graph;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lain-findtool-"));
    storage = new Storage(path.join(tmp, "t.db"));
    graph = new Graph(storage);
    graph.createExploration({ id: "e", name: "n", seed: "s", n: 2, m: 1, strategy: "bf", planDetail: "sentence", extension: "freeform" });
  });
  afterEach(() => { storage.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it("note_finding writes and read_findings reads across nodes", async () => {
    const tools = buildNodeTools({ hasCorpus: false });
    const note = tools.find((t) => t.spec.name === "note_finding")!;
    const read = tools.find((t) => t.spec.name === "read_findings")!;
    expect(note && read).toBeTruthy();

    const ctx1 = buildToolContext({ graph, storage, corpus: null, exploration: graph.getExploration("e")!, currentNodeId: "root-1" });
    await note.handler({ content: "spores carry messages", tags: ["bio"] }, ctx1);

    const ctx2 = buildToolContext({ graph, storage, corpus: null, exploration: graph.getExploration("e")!, currentNodeId: "root-2" });
    const out = await read.handler({}, ctx2);
    const text = out.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(text).toContain("spores carry messages");
    expect(storage.getFindings("e")).toHaveLength(1);
  });
});
