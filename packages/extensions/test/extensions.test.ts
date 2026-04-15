import { describe, it, expect } from "vitest";
import { ExtensionRegistry } from "../src/registry.js";
import { freeformExtension } from "../src/builtins/freeform.js";
import { worldbuildingExtension } from "../src/builtins/worldbuilding.js";
import { debateExtension } from "../src/builtins/debate.js";
import { researchExtension } from "../src/builtins/research.js";
import type { LainExtension, NodeContext, PlanContext, LainNode, Exploration } from "@lain/shared";

function makeNode(overrides: Partial<LainNode> = {}): LainNode {
  return {
    id: "root-1",
    explorationId: "test",
    parentId: "root",
    content: "Test content",
    contentConflict: null,
    title: "Test Node",
    depth: 1,
    branchIndex: 1,
    status: "complete",
    model: null,
    provider: null,
    planSummary: null,
    extensionData: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeExploration(overrides: Partial<Exploration> = {}): Exploration {
  return {
    id: "test",
    name: "Test",
    seed: "Test seed",
    n: 3,
    m: 2,
    strategy: "bf",
    planDetail: "sentence",
    extension: "freeform",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeNodeContext(overrides: Partial<NodeContext> = {}): NodeContext {
  return {
    node: makeNode(),
    ancestors: [makeNode({ id: "root", parentId: null, depth: 0 })],
    siblings: [],
    exploration: makeExploration(),
    depth: 1,
    ...overrides,
  };
}

function makePlanContext(overrides: Partial<PlanContext> = {}): PlanContext {
  return {
    parentNode: makeNode({ id: "root", parentId: null, depth: 0 }),
    ancestors: [],
    exploration: makeExploration(),
    n: 3,
    detail: "sentence",
    ...overrides,
  };
}

describe("ExtensionRegistry", () => {
  it("registers and retrieves extensions", () => {
    const registry = new ExtensionRegistry();
    registry.register(freeformExtension);
    registry.register(worldbuildingExtension);

    expect(registry.get("freeform")).toBe(freeformExtension);
    expect(registry.get("worldbuilding")).toBe(worldbuildingExtension);
    expect(registry.get("nonexistent")).toBeUndefined();
    expect(registry.names()).toEqual(["freeform", "worldbuilding"]);
  });

  it("throws on duplicate registration", () => {
    const registry = new ExtensionRegistry();
    registry.register(freeformExtension);
    expect(() => registry.register(freeformExtension)).toThrow("already registered");
  });

  it("collects system prompts from active extensions", () => {
    const registry = new ExtensionRegistry();
    registry.register(freeformExtension);
    registry.register(worldbuildingExtension);
    registry.register(debateExtension);

    // Worldbuilding only
    const wbPrompt = registry.getSystemPrompt(makeNodeContext(), ["worldbuilding"]);
    expect(wbPrompt).toContain("worldbuilding engine");
    expect(wbPrompt).not.toContain("debate engine");

    // Debate only
    const dbPrompt = registry.getSystemPrompt(makeNodeContext(), ["debate"]);
    expect(dbPrompt).toContain("debate engine");
    expect(dbPrompt).not.toContain("worldbuilding");

    // Freeform returns nothing (no systemPrompt)
    const freePrompt = registry.getSystemPrompt(makeNodeContext(), ["freeform"]);
    expect(freePrompt).toBe("");
  });

  it("collects plan prompts from active extensions", () => {
    const registry = new ExtensionRegistry();
    registry.register(worldbuildingExtension);

    const prompt = registry.getPlanPrompt(makePlanContext(), ["worldbuilding"]);
    expect(prompt).toContain("Geography");
    expect(prompt).toContain("Cultures");
  });

  it("runs after:plan hooks to modify directions", async () => {
    const custom: LainExtension = {
      name: "custom",
      version: "1.0.0",
      hooks: {
        "after:plan": (_ctx, directions) => {
          return directions.map((d) => `[MODIFIED] ${d}`);
        },
      },
    };

    const registry = new ExtensionRegistry();
    registry.register(custom);

    const result = await registry.runAfterPlan(
      makePlanContext(),
      ["dir1", "dir2", "dir3"],
      ["custom"]
    );

    expect(result[0]).toBe("[MODIFIED] dir1");
    expect(result[2]).toBe("[MODIFIED] dir3");
  });

  it("runs after:generate hooks to modify response", async () => {
    const custom: LainExtension = {
      name: "custom",
      version: "1.0.0",
      hooks: {
        "after:generate": (_ctx, response) => {
          return { ...response, title: `[EXT] ${response.title}` };
        },
      },
    };

    const registry = new ExtensionRegistry();
    registry.register(custom);

    const result = await registry.runAfterGenerate(
      makeNodeContext(),
      { title: "Original", content: "Content", model: "test", provider: "anthropic" },
      ["custom"]
    );

    expect(result.title).toBe("[EXT] Original");
    expect(result.content).toBe("Content");
  });

  it("runs validators", () => {
    const registry = new ExtensionRegistry();
    registry.register(researchExtension);

    // Research extension has a citation-check validator
    const result = registry.runValidators(
      "after:generate",
      makeNodeContext(),
      { title: "Test", content: "No citations here.", model: "test", provider: "anthropic" },
      ["research"]
    );

    // Citation check is a soft check (valid: true, but with message)
    expect(result.valid).toBe(true);
  });

  it("returns empty for extensions with no hooks", async () => {
    const registry = new ExtensionRegistry();
    registry.register(freeformExtension);

    const prompt = registry.getSystemPrompt(makeNodeContext(), ["freeform"]);
    expect(prompt).toBe("");

    const dirs = await registry.runAfterPlan(makePlanContext(), ["a", "b"], ["freeform"]);
    expect(dirs).toEqual(["a", "b"]);
  });
});

describe("Built-in extensions", () => {
  it("worldbuilding has depth-specific system prompts", () => {
    const registry = new ExtensionRegistry();
    registry.register(worldbuildingExtension);

    const shallowPrompt = registry.getSystemPrompt(
      makeNodeContext({ depth: 1 }),
      ["worldbuilding"]
    );
    expect(shallowPrompt).toContain("broad strokes");

    const deepPrompt = registry.getSystemPrompt(
      makeNodeContext({ depth: 3 }),
      ["worldbuilding"]
    );
    expect(deepPrompt).toContain("granular");
  });

  it("debate has depth-specific system prompts", () => {
    const registry = new ExtensionRegistry();
    registry.register(debateExtension);

    const shallowPrompt = registry.getSystemPrompt(
      makeNodeContext({ depth: 1 }),
      ["debate"]
    );
    expect(shallowPrompt).toContain("clear POSITION");

    const deepPrompt = registry.getSystemPrompt(
      makeNodeContext({ depth: 2 }),
      ["debate"]
    );
    expect(deepPrompt).toContain("STEELMAN");
  });

  it("research has citation validator", () => {
    expect(researchExtension.validators).toHaveLength(1);
    expect(researchExtension.validators![0].name).toBe("citation-check");
  });

  it("worldbuilding has config schema", () => {
    expect(worldbuildingExtension.configSchema).toBeDefined();
    expect(worldbuildingExtension.configSchema!.length).toBeGreaterThan(0);
    expect(worldbuildingExtension.configSchema!.find((f) => f.key === "genre")).toBeDefined();
  });
});
