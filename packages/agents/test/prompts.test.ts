import { describe, it, expect } from "vitest";
import {
  buildGeneratePrompt,
  buildPlanPrompt,
  buildSynthesizePrompt,
  parseSynthesizeResponse,
} from "../src/prompts.js";
import type {
  GenerateRequest,
  PlanRequest,
  SynthesizeRequest,
  LainNode,
  Exploration,
} from "@lain/shared";

const mockNode = (overrides: Partial<LainNode> = {}): LainNode => ({
  id: "root-1",
  explorationId: "exp-1",
  parentId: "root",
  content: "Node content here",
  contentConflict: null,
  title: "Test Node",
  depth: 1,
  branchIndex: 1,
  status: "complete",
  model: "test",
  provider: "anthropic",
  planSummary: "Explore direction A",
  extensionData: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

const mockExploration: Exploration = {
  id: "exp-1",
  name: "Test Exploration",
  seed: "What if trees could talk",
  n: 3,
  m: 3,
  strategy: "bf",
  planDetail: "sentence",
  extension: "freeform",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("buildGeneratePrompt", () => {
  it("includes system rules", () => {
    const request: GenerateRequest = {
      node: mockNode(),
      ancestors: [mockNode({ id: "root", parentId: null, depth: 0, title: "Root" })],
      siblings: [],
      exploration: mockExploration,
    };

    const { system } = buildGeneratePrompt(request);
    expect(system).toContain("ideation engine");
    expect(system).toContain("different from your siblings");
  });

  it("includes ancestor chain in user prompt", () => {
    const request: GenerateRequest = {
      node: mockNode(),
      ancestors: [mockNode({ id: "root", parentId: null, depth: 0, title: "Root Ancestor" })],
      siblings: [],
      exploration: mockExploration,
    };

    const { user } = buildGeneratePrompt(request);
    expect(user).toContain("Root Ancestor");
    expect(user).toContain("Ancestor chain");
  });

  it("includes sibling context", () => {
    const request: GenerateRequest = {
      node: mockNode({ id: "root-2" }),
      ancestors: [],
      siblings: [mockNode({ id: "root-1", title: "Sibling Node", content: "Sibling explores X" })],
      exploration: mockExploration,
    };

    const { user } = buildGeneratePrompt(request);
    expect(user).toContain("Sibling Node");
    expect(user).toContain("Sibling explores X");
  });

  it("includes plan summary as direction", () => {
    const request: GenerateRequest = {
      node: mockNode({ planSummary: "Explore underwater agriculture" }),
      ancestors: [],
      siblings: [],
      exploration: mockExploration,
    };

    const { user } = buildGeneratePrompt(request);
    expect(user).toContain("Explore underwater agriculture");
  });

  it("includes extension system prompt when provided", () => {
    const request: GenerateRequest = {
      node: mockNode(),
      ancestors: [],
      siblings: [],
      exploration: mockExploration,
      extensionSystemPrompt: "You are a worldbuilding engine.",
    };

    const { system } = buildGeneratePrompt(request);
    expect(system).toContain("You are a worldbuilding engine.");
  });
});

describe("buildPlanPrompt", () => {
  it("requests correct number of directions", () => {
    const request: PlanRequest = {
      parentNode: mockNode({ id: "root", parentId: null }),
      ancestors: [],
      exploration: mockExploration,
      n: 5,
      detail: "sentence",
    };

    const { user } = buildPlanPrompt(request);
    expect(user).toContain("exactly 5 different directions");
  });

  it("includes detail level instruction for brief", () => {
    const request: PlanRequest = {
      parentNode: mockNode({ id: "root", parentId: null }),
      ancestors: [],
      exploration: mockExploration,
      n: 3,
      detail: "brief",
    };

    const { user } = buildPlanPrompt(request);
    expect(user).toContain("~5 words maximum");
  });

  it("includes detail level instruction for detailed", () => {
    const request: PlanRequest = {
      parentNode: mockNode({ id: "root", parentId: null }),
      ancestors: [],
      exploration: mockExploration,
      n: 3,
      detail: "detailed",
    };

    const { user } = buildPlanPrompt(request);
    expect(user).toContain("2-3 sentences");
  });
});

describe("parseSynthesizeResponse", () => {
  it("parses valid JSON with annotations", () => {
    const json = JSON.stringify({
      summary: "Test summary",
      annotations: [
        { type: "crosslink", sourceNodeId: "root-1", targetNodeId: "root-2", content: "connection" },
        { type: "note", sourceNodeId: "root-1", content: "observation" },
      ],
    });

    const result = parseSynthesizeResponse(json, "test-model", "anthropic");
    expect(result.summary).toBe("Test summary");
    expect(result.annotations).toHaveLength(2);
    expect(result.annotations[0].type).toBe("crosslink");
    expect(result.annotations[1].type).toBe("note");
    expect(result.model).toBe("test-model");
  });

  it("handles markdown code fences", () => {
    const json = '```json\n{"summary": "fenced", "annotations": []}\n```';
    const result = parseSynthesizeResponse(json, "m", "anthropic");
    expect(result.summary).toBe("fenced");
  });

  it("filters invalid annotation types", () => {
    const json = JSON.stringify({
      summary: "s",
      annotations: [
        { type: "crosslink", sourceNodeId: "a", targetNodeId: "b", content: "ok" },
        { type: "invalid_type", sourceNodeId: "a", content: "bad" },
      ],
    });
    const result = parseSynthesizeResponse(json, "m", "anthropic");
    expect(result.annotations).toHaveLength(1);
  });

  it("falls back to raw text on completely invalid input", () => {
    const result = parseSynthesizeResponse("not json at all", "m", "anthropic");
    expect(result.summary).toBe("not json at all");
    expect(result.annotations).toEqual([]);
  });

  it("extracts JSON from surrounding prose", () => {
    const text = 'Here is my analysis:\n{"summary": "extracted", "annotations": []}\nDone.';
    const result = parseSynthesizeResponse(text, "m", "anthropic");
    expect(result.summary).toBe("extracted");
  });
});
