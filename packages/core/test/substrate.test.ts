import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runAgent } from "@lain/agents";
import type {
  AgentProvider,
  ConverseRequest,
  ConverseResult,
  GenerateRequest,
  GenerateResponse,
  PlanRequest,
  PlanResponse,
  SynthesizeRequest,
  SynthesizeResponse,
  Provider,
  AgentStepEvent,
} from "@lain/shared";
import { Storage } from "../src/storage.js";
import { Graph } from "../src/graph.js";
import { Corpus } from "../src/corpus.js";
import { generateNodeAgentic } from "../src/agentic.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * A scripted provider: each call to `converse` returns the next turn from a
 * supplied script, letting us deterministically test the tool loop without a
 * network. Implements the full AgentProvider surface (unused methods throw).
 */
class ScriptedProvider implements AgentProvider {
  modelId = "scripted-1";
  providerName: Provider = "anthropic";
  calls: ConverseRequest[] = [];
  private turns: ConverseResult[];
  private i = 0;

  constructor(turns: ConverseResult[]) {
    this.turns = turns;
  }

  async converse(request: ConverseRequest): Promise<ConverseResult> {
    // Snapshot the request (the runner reuses one live messages array).
    this.calls.push(JSON.parse(JSON.stringify(request)) as ConverseRequest);
    const turn = this.turns[Math.min(this.i, this.turns.length - 1)];
    this.i++;
    return turn;
  }

  async generate(_r: GenerateRequest): Promise<GenerateResponse> {
    throw new Error("not used");
  }
  async generateStream(_r: GenerateRequest): Promise<GenerateResponse> {
    throw new Error("not used");
  }
  async plan(_r: PlanRequest): Promise<PlanResponse> {
    throw new Error("not used");
  }
  async synthesize(_r: SynthesizeRequest): Promise<SynthesizeResponse> {
    throw new Error("not used");
  }
  async generateRaw(): Promise<string> {
    return "";
  }
}

describe("runAgent tool loop", () => {
  it("executes a requested tool then finishes on end_turn", async () => {
    const provider = new ScriptedProvider([
      {
        stopReason: "tool_use",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "t1", name: "echo", input: { msg: "hi" } },
        ],
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        stopReason: "end_turn",
        content: [{ type: "text", text: "Final answer." }],
        usage: { inputTokens: 12, outputTokens: 4 },
      },
    ]);

    const events: AgentStepEvent[] = [];
    const result = await runAgent({
      provider,
      system: "sys",
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      tools: [{ name: "echo", description: "echo", inputSchema: { type: "object" } }],
      dispatch: async (call) => ({
        content: [{ type: "text", text: `echoed:${(call.input as { msg: string }).msg}` }],
      }),
      onEvent: (e) => events.push(e),
    });

    expect(result.text).toBe("Final answer.");
    expect(result.stopReason).toBe("end_turn");
    expect(result.toolCalls).toBe(1);
    expect(result.usage.inputTokens).toBe(22);
    expect(result.usage.outputTokens).toBe(9);
    // The tool result must have been fed back to the provider on the 2nd call.
    const secondCall = provider.calls[1];
    const lastMsg = secondCall.messages[secondCall.messages.length - 1];
    expect(lastMsg.role).toBe("user");
    expect(lastMsg.content[0].type).toBe("tool_result");
    // Event stream includes a tool_call + tool_result + done.
    expect(events.some((e) => e.kind === "tool_call" && e.name === "echo")).toBe(true);
    expect(events.some((e) => e.kind === "done")).toBe(true);
  });

  it("stops at the step budget", async () => {
    // Always requests a tool -> would loop forever without a budget.
    const provider = new ScriptedProvider([
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "t", name: "noop", input: {} }],
      },
    ]);
    const result = await runAgent({
      provider,
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      tools: [{ name: "noop", description: "n", inputSchema: { type: "object" } }],
      dispatch: async () => ({ content: [{ type: "text", text: "ok" }] }),
      maxSteps: 3,
    });
    expect(result.steps).toBe(3);
  });

  it("surfaces tool errors without crashing the loop", async () => {
    const provider = new ScriptedProvider([
      { stopReason: "tool_use", content: [{ type: "tool_use", id: "t", name: "boom", input: {} }] },
      { stopReason: "end_turn", content: [{ type: "text", text: "recovered" }] },
    ]);
    const result = await runAgent({
      provider,
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      tools: [{ name: "boom", description: "b", inputSchema: { type: "object" } }],
      dispatch: async () => {
        throw new Error("kaboom");
      },
    });
    expect(result.text).toBe("recovered");
  });
});

describe("generateNodeAgentic", () => {
  let tmpDir: string;
  let storage: Storage;
  let graph: Graph;
  let corpus: Corpus;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lain-agentic-"));
    storage = new Storage(path.join(tmpDir, "t.db"));
    graph = new Graph(storage);
    graph.createExploration({
      id: "exp",
      name: "T",
      seed: "underwater cities",
      n: 2,
      m: 2,
      strategy: "bf",
      planDetail: "sentence",
      extension: "freeform",
    });
    // root + one completed sibling so the agent has graph context to read.
    storage.updateNodeContent("root", "Underwater Cities", "Seed root.", "m", "manual");
    const kids = graph.createChildNodes("exp", "root", 2, ["pressure culture", "ecology"]);
    storage.updateNodeContent(kids[0].id, "Pressure Culture", "How pressure shapes society.", "m", "manual");
    corpus = new Corpus(storage);
  });

  afterEach(() => {
    storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uses tools then emits a parsed title/content node", async () => {
    corpus.ingestText("exp", { name: "lore.md", text: "The abyssal trade guilds control bioluminescent currency." });

    const provider = new ScriptedProvider([
      // 1) consult the corpus
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "c1", name: "search_corpus", input: { query: "currency" } }],
      },
      // 2) look at the graph
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "c2", name: "outline", input: {} }],
      },
      // 3) link to the sibling
      {
        stopReason: "tool_use",
        content: [
          { type: "tool_use", id: "c3", name: "link_to_node", input: { target_node_id: "root-1", relationship: "shared economy" } },
        ],
      },
      // 4) final node
      {
        stopReason: "end_turn",
        content: [{ type: "text", text: "# Bioluminescent Markets\n\nGuilds mint light as money." }],
      },
    ]);

    const target = graph.getNode("root-2")!;
    const events: AgentStepEvent[] = [];
    const res = await generateNodeAgentic(target, {
      agent: provider,
      graph,
      corpus,
      exploration: graph.getExploration("exp")!,
      onStep: (e) => events.push(e),
    });

    expect(res.title).toBe("Bioluminescent Markets");
    expect(res.content).toBe("Guilds mint light as money.");
    expect(res.provider).toBe("anthropic");
    expect(res.model).toBe("scripted-1");

    // The corpus tool was advertised (since corpus is non-empty).
    const firstCall = provider.calls[0];
    expect(firstCall.tools?.some((t) => t.name === "search_corpus")).toBe(true);

    // The link_to_node tool actually created a crosslink in the graph.
    const links = graph.getCrosslinksForNode("root-2");
    expect(links.some((l) => l.targetId === "root-1" || l.sourceId === "root-1")).toBe(true);

    // Streaming events surfaced the tool calls.
    expect(events.filter((e) => e.kind === "tool_call").length).toBe(3);
  });

  it("adapts and dispatches extension tools (sub-agent + corpus access)", async () => {
    corpus.ingestText("exp", { name: "lore.md", text: "Names in the deep end in -uul: Zindabuul, Maruul." });

    let extToolCalled = false;
    let sawCorpusInPrompt = false;
    const extensionTools = [
      {
        spec: {
          name: "coin_names",
          description: "coin names",
          inputSchema: { type: "object", properties: { concept: { type: "string" } }, required: ["concept"] },
        },
        async handler(input: Record<string, unknown>, ctx: import("@lain/shared").ExtensionToolContext) {
          extToolCalled = true;
          // exercise corpus access + sub-agent call through the adapter
          const passages = ctx.searchCorpus(String(input.concept), 3);
          if (passages.some((p) => /uul/.test(p.text))) sawCorpusInPrompt = true;
          const out = await ctx.callAgent("coin names", "concept");
          return { content: [{ type: "text" as const, text: out }] };
        },
      },
    ];

    // Provider: scripts the node-agent turns, AND answers the sub-agent callAgent
    // (generateRaw) call deterministically.
    const provider = new ScriptedProvider([
      { stopReason: "tool_use", content: [{ type: "tool_use", id: "x1", name: "coin_names", input: { concept: "names in the deep" } }] },
      { stopReason: "tool_use", content: [{ type: "tool_use", id: "x2", name: "submit_node", input: { title: "Rites of the Deep", content: "The Vauluul ceremony." } }] },
    ]);
    // generateRaw is used by the adapter's callAgent.
    (provider as unknown as { generateRaw: () => Promise<string> }).generateRaw = async () => "Vauluul — a sinking rite";

    const target = graph.getNode("root-2")!;
    const res = await generateNodeAgentic(target, {
      agent: provider,
      graph,
      corpus,
      exploration: graph.getExploration("exp")!,
      extensionTools,
    });

    expect(extToolCalled).toBe(true);
    expect(sawCorpusInPrompt).toBe(true);
    expect(res.title).toBe("Rites of the Deep");
    // coin_names tool must have been advertised to the model.
    expect(provider.calls[0].tools?.some((t) => t.name === "coin_names")).toBe(true);
  });

  it("omits corpus tools when the corpus is empty", async () => {
    const provider = new ScriptedProvider([
      { stopReason: "end_turn", content: [{ type: "text", text: "# T\n\nbody" }] },
    ]);
    const target = graph.getNode("root-2")!;
    await generateNodeAgentic(target, {
      agent: provider,
      graph,
      corpus, // empty
      exploration: graph.getExploration("exp")!,
    });
    const advertised = provider.calls[0].tools?.map((t) => t.name) ?? [];
    expect(advertised).not.toContain("search_corpus");
    expect(advertised).toContain("outline");
  });
});
