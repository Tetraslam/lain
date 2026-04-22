import { describe, it, expect } from "vitest";
import {
  buildMergeGenerationPrompt,
  parseMergeGenerationResponse,
  type MergeGenerationRequest,
  type LainNode,
} from "@lain/shared";

describe("buildMergeGenerationPrompt", () => {
  const mockNode = (overrides: Partial<LainNode> = {}): LainNode => ({
    id: "root-1",
    explorationId: "exp-1",
    parentId: "root",
    content: "Test content for the node",
    contentConflict: null,
    title: "Test Node",
    depth: 1,
    branchIndex: 1,
    status: "complete",
    model: "test",
    provider: "anthropic",
    planSummary: null,
    extensionData: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  });

  it("builds a contradiction resolution prompt", () => {
    const request: MergeGenerationRequest = {
      type: "contradiction",
      sourceNode: mockNode({ id: "root-1", title: "Source", content: "Source content" }),
      targetNode: mockNode({ id: "root-2", title: "Target", content: "Target content" }),
      annotationContent: "These nodes contradict on timing",
      explorationSeed: "What if cities were underwater",
    };

    const { system, user } = buildMergeGenerationPrompt(request);

    expect(system).toContain("resolution agent");
    expect(system).toContain("reconciles");
    expect(system).toContain("JSON");
    expect(user).toContain("Source");
    expect(user).toContain("Target");
    expect(user).toContain("Source content");
    expect(user).toContain("Target content");
    expect(user).toContain("The contradiction");
    expect(user).toContain("These nodes contradict on timing");
  });

  it("builds a merge_suggestion synthesis prompt", () => {
    const request: MergeGenerationRequest = {
      type: "merge_suggestion",
      sourceNode: mockNode({ id: "root-1", title: "Branch A" }),
      targetNode: mockNode({ id: "root-2", title: "Branch B" }),
      annotationContent: "They converge on the same mechanism",
      explorationSeed: "AI future",
    };

    const { system, user } = buildMergeGenerationPrompt(request);

    expect(system).toContain("synthesis agent");
    expect(system).toContain("unifies");
    expect(user).toContain("Why these should merge");
    expect(user).toContain("They converge on the same mechanism");
  });

  it("handles nodes with no content", () => {
    const request: MergeGenerationRequest = {
      type: "contradiction",
      sourceNode: mockNode({ content: null, title: null }),
      targetNode: mockNode({ content: null, title: null }),
      annotationContent: "test",
      explorationSeed: "seed",
    };

    const { user } = buildMergeGenerationPrompt(request);
    expect(user).toContain("(no content)");
  });
});

describe("parseMergeGenerationResponse", () => {
  it("parses valid JSON response", () => {
    const result = parseMergeGenerationResponse(
      '{"title": "Resolution Title", "content": "The resolution content."}'
    );
    expect(result.title).toBe("Resolution Title");
    expect(result.content).toBe("The resolution content.");
  });

  it("handles markdown code fences", () => {
    const result = parseMergeGenerationResponse(
      '```json\n{"title": "Fenced", "content": "Content here"}\n```'
    );
    expect(result.title).toBe("Fenced");
    expect(result.content).toBe("Content here");
  });

  it("extracts JSON from surrounding text", () => {
    const result = parseMergeGenerationResponse(
      'Here is my response:\n{"title": "Extracted", "content": "From text"}\nEnd.'
    );
    expect(result.title).toBe("Extracted");
    expect(result.content).toBe("From text");
  });

  it("falls back to raw text on invalid JSON", () => {
    const result = parseMergeGenerationResponse("This is not JSON at all");
    expect(result.title).toBe("Resolution");
    expect(result.content).toBe("This is not JSON at all");
  });

  it("handles missing title field", () => {
    const result = parseMergeGenerationResponse('{"content": "Just content"}');
    expect(result.title).toBe("Untitled");
    expect(result.content).toBe("Just content");
  });

  it("handles missing content field", () => {
    const result = parseMergeGenerationResponse('{"title": "Just title"}');
    expect(result.title).toBe("Just title");
    expect(result.content).toBe('{"title": "Just title"}');
  });
});
