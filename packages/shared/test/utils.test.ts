import { describe, it, expect } from "vitest";
import {
  generateId,
  nowISO,
  buildNodeId,
  estimateCost,
  slugify,
  type PlanDetail,
} from "@lain/shared";

describe("generateId", () => {
  it("returns an 8-character string", () => {
    const id = generateId();
    expect(id).toHaveLength(8);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

describe("nowISO", () => {
  it("returns a valid ISO 8601 string", () => {
    const now = nowISO();
    expect(new Date(now).toISOString()).toBe(now);
  });
});

describe("buildNodeId", () => {
  it("returns 'root' for null parent", () => {
    expect(buildNodeId(null, 0)).toBe("root");
  });

  it("appends branch index to parent id", () => {
    expect(buildNodeId("root", 1)).toBe("root-1");
    expect(buildNodeId("root", 2)).toBe("root-2");
    expect(buildNodeId("root-1", 3)).toBe("root-1-3");
  });

  it("handles deeply nested IDs", () => {
    expect(buildNodeId("root-1-2-3", 4)).toBe("root-1-2-3-4");
  });
});

describe("estimateCost", () => {
  it("calculates correct total nodes", () => {
    // n=3, m=2: 3 + 9 = 12 nodes
    const est = estimateCost(3, 2, "claude-sonnet-4-6", "sentence");
    expect(est.totalNodes).toBe(12);
  });

  it("calculates correct plan calls with none detail", () => {
    const est = estimateCost(3, 2, "claude-sonnet-4-6", "none");
    expect(est.planCalls).toBe(0);
  });

  it("calculates correct plan calls with sentence detail", () => {
    // Parents that get expanded: 1 (root) + 3 = 4 (for n=3, m=2)
    const est = estimateCost(3, 2, "claude-sonnet-4-6", "sentence");
    expect(est.planCalls).toBe(4);
  });

  it("returns non-zero cost", () => {
    const est = estimateCost(3, 2, "claude-sonnet-4-6", "sentence");
    expect(est.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("handles n=1 edge case", () => {
    const est = estimateCost(1, 5, "claude-sonnet-4-6", "sentence");
    expect(est.totalNodes).toBe(5);
    expect(est.planCalls).toBe(5);
  });

  it("uses fallback pricing for unknown models", () => {
    const est = estimateCost(2, 2, "unknown-model", "sentence");
    expect(est.estimatedCostUsd).toBeGreaterThan(0);
    expect(est.model).toBe("unknown-model");
  });
});

describe("slugify", () => {
  it("converts to lowercase", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("replaces non-alphanumeric with hyphens", () => {
    expect(slugify("what if we built cities underwater?")).toBe("what-if-we-built-cities-underwater");
  });

  it("trims leading/trailing hyphens", () => {
    expect(slugify("---test---")).toBe("test");
  });

  it("truncates at 50 characters", () => {
    const long = "a".repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(50);
  });
});
