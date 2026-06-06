import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Storage } from "../src/storage.js";
import { Graph } from "../src/graph.js";
import { parseContract } from "../src/mission.js";
import { buildNodeTools, buildToolContext } from "../src/tools.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("parseContract", () => {
  it("extracts intent + criteria from JSON", () => {
    const r = parseContract('prefix {"intent":"go deep","criteria":["a","b","c"]} suffix');
    expect(r.intent).toBe("go deep");
    expect(r.criteria).toEqual(["a", "b", "c"]);
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

  it("upserts and reads a mission", () => {
    storage.upsertMission({ explorationId: "e", intent: "the goal", criteria: ["x", "y"], createdAt: new Date().toISOString() });
    const m = storage.getMission("e")!;
    expect(m.intent).toBe("the goal");
    expect(m.criteria).toEqual(["x", "y"]);
    // upsert overwrites
    storage.upsertMission({ explorationId: "e", intent: "new goal", criteria: ["z"], createdAt: new Date().toISOString() });
    expect(storage.getMission("e")!.intent).toBe("new goal");
  });

  it("stores and lists findings", () => {
    storage.createFinding({ id: "f1", explorationId: "e", nodeId: "root-1", content: "the deep is cold", tags: ["env"], createdAt: new Date().toISOString() });
    storage.createFinding({ id: "f2", explorationId: "e", nodeId: "root-2", content: "trade uses light", tags: [], createdAt: new Date().toISOString() });
    const fs2 = storage.getFindings("e");
    expect(fs2).toHaveLength(2);
    expect(fs2[0].content).toBe("the deep is cold");
    expect(fs2[0].tags).toEqual(["env"]);
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

    // node root-1 records a finding
    const ctx1 = buildToolContext({ graph, storage, corpus: null, exploration: graph.getExploration("e")!, currentNodeId: "root-1" });
    await note.handler({ content: "spores carry messages", tags: ["bio"] }, ctx1);

    // node root-2 reads it (own-node findings excluded, so root-2 sees root-1's)
    const ctx2 = buildToolContext({ graph, storage, corpus: null, exploration: graph.getExploration("e")!, currentNodeId: "root-2" });
    const out = await read.handler({}, ctx2);
    const text = out.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(text).toContain("spores carry messages");
    expect(storage.getFindings("e")).toHaveLength(1);
  });
});
