import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Storage } from "../src/storage.js";
import { Graph } from "../src/graph.js";
import { Orchestrator } from "../src/orchestrator.js";
import { parseContract, interviewMission } from "../src/mission.js";
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
    // Check the revise/orchestrator role before the validator role: the revise
    // prompt also mentions "independent validator", so order matters here.
    if (system.includes("orchestrator of an ideation mission")) {
      // Revise an existing node (no new nodes) to close the A1 gap.
      return '{"revisions":[{"node":"root-1","assertions":["A1"],"critique":"add the risks explicitly"}]}';
    }
    if (system.includes("independent validator")) {
      this.validateCalls++;
      if (this.validateCalls === 1) {
        return '{"results":[{"id":"A1","status":"unmet","evidence":""},{"id":"A2","status":"met","evidence":"root-2"}],"summary":"risk not covered"}';
      }
      return '{"results":[{"id":"A1","status":"met","evidence":"root-3"},{"id":"A2","status":"met","evidence":"root-2"}],"summary":"complete"}';
    }
    return "{}";
  }
}

// Interview agent: asks once, then finalizes a contract once it has an answer.
class InterviewAgent implements AgentProvider {
  async generate(): Promise<GenerateResponse> { return { title: "t", content: "c", model: "mock", provider: "anthropic" }; }
  async generateStream(): Promise<GenerateResponse> { return this.generate(); }
  async plan(r: PlanRequest): Promise<PlanResponse> { return { directions: Array.from({ length: r.n }, (_, i) => `d${i}`) }; }
  async generateRaw(system: string, user: string): Promise<string> {
    if (system.includes("Front-load the thinking")) {
      // First turn (no clarifications yet) → ask; subsequent → finalize.
      if (!user.includes("Clarifications so far")) {
        return '{"ready":false,"questions":["Who is the audience?","What is out of scope?"]}';
      }
      return '{"ready":true,"intent":"clear goal","assertions":[{"id":"A1","text":"x"},{"id":"A2","text":"y"}],"features":[{"id":"F1","angle":"one","assertions":["A1"]},{"id":"F2","angle":"two","assertions":["A2"]}]}';
    }
    return "{}";
  }
}

describe("interviewMission (cognitive-frontloading gate)", () => {
  it("asks clarifying questions before it will finalize", async () => {
    const r = await interviewMission(new InterviewAgent(), "e", "a seed", 2, []);
    expect(r.done).toBe(false);
    if (!r.done) expect(r.questions.length).toBeGreaterThan(0);
  });

  it("finalizes a contract once questions are answered", async () => {
    const r = await interviewMission(new InterviewAgent(), "e", "a seed", 2, [
      { question: "Who is the audience?", answer: "researchers" },
      { question: "What is out of scope?", answer: "implementation" },
    ]);
    expect(r.done).toBe(true);
    if (r.done) {
      expect(r.mission.assertions.length).toBe(2);
      expect(r.mission.features.length).toBe(2);
      expect(r.mission.intent).toBe("clear goal");
    }
  });

  it("forces finalization after maxRounds even if the agent keeps asking", async () => {
    // An agent that ALWAYS asks — the gate must still terminate.
    const stubborn: AgentProvider = {
      generate: async () => ({ title: "t", content: "c", model: "m", provider: "anthropic" }),
      generateStream: async () => ({ title: "t", content: "c", model: "m", provider: "anthropic" }),
      plan: async (r) => ({ directions: Array.from({ length: r.n }, (_, i) => `d${i}`) }),
      generateRaw: async () => '{"ready":false,"questions":["again?"]}',
    } as AgentProvider;
    const history = [
      { question: "q1", answer: "a1" }, { question: "q2", answer: "a2" }, { question: "q3", answer: "a3" },
    ];
    const r = await interviewMission(stubborn, "e", "seed", 2, history, { maxRounds: 3 });
    expect(r.done).toBe(true); // reached the cap → finalized regardless
  });
});

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

    // The fix REVISED an existing node in place — no new nodes were added.
    expect(orch.getGraph().getAllNodes("e").length).toBe(before);
    expect(storage.getMissionReports("e")).toHaveLength(2);
    orch.close();
  });

  it("revises nodes in place across rounds — never adds nodes or grows depth", async () => {
    // The validator stays unmet so the fix loop runs every round; each round must
    // REVISE the cited node (regenerate it), never spawn a new node.
    const regenerated: string[] = [];
    class ReviseAgent implements AgentProvider {
      async generate(r: GenerateRequest): Promise<GenerateResponse> {
        regenerated.push(r.node.id);
        return { title: `T ${r.node.id}`, content: `C ${r.node.id} #${regenerated.filter((x) => x === r.node.id).length}`, model: "mock", provider: "anthropic" };
      }
      async generateStream(r: GenerateRequest, on: (c: string) => void): Promise<GenerateResponse> {
        const x = await this.generate(r); on(x.content); return x;
      }
      async plan(r: PlanRequest): Promise<PlanResponse> { return { directions: Array.from({ length: r.n }, (_, i) => `d${i + 1}`) }; }
      async generateRaw(system: string): Promise<string> {
        if (system.includes("orchestrator of an ideation mission")) {
          return '{"revisions":[{"node":"root-1","assertions":["A1"],"critique":"go deeper on root-1"}]}';
        }
        if (system.includes("independent validator")) {
          return '{"results":[{"id":"A1","status":"partial","evidence":"root-1 is shallow"}],"summary":"still shallow"}';
        }
        return "{}";
      }
    }
    const orch = new Orchestrator({ dbPath, agent: new ReviseAgent() });
    await orch.explore({ id: "e", name: "n", seed: "x", n: 2, m: 2, strategy: "bf", planDetail: "sentence", extension: "freeform" });
    orch.getStorage().upsertMission({
      explorationId: "e", intent: "g",
      assertions: [{ id: "A1", text: "covers it" }],
      features: [], createdAt: new Date().toISOString(),
    });

    const before = orch.getGraph().getAllNodes("e").length;
    const beforeDepth = Math.max(...orch.getGraph().getAllNodes("e").map((n) => n.depth));
    regenerated.length = 0;
    await orch.pursueMission("e", { maxRounds: 3 });

    const after = orch.getGraph().getAllNodes("e");
    expect(after.length).toBe(before);                               // no new nodes
    expect(Math.max(...after.map((n) => n.depth))).toBe(beforeDepth); // no deeper
    expect(regenerated.filter((id) => id === "root-1").length).toBe(3); // root-1 revised each round
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
