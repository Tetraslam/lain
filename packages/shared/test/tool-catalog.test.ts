import { describe, it, expect } from "vitest";
import {
  emptyToolSelection,
  normalizeToolSelection,
  isGroupEnabled,
  isToolEnabled,
  toggleGroup,
  toggleTool,
  resolveDisabledToolIds,
  enabledMcpServers,
  countActiveTools,
  type ToolCatalog,
} from "@lain/shared";

const catalog: ToolCatalog = {
  groups: [
    { id: "builtin", title: "Built-in", kind: "builtin", tools: [
      { id: "outline", title: "o", description: "" },
      { id: "search_nodes", title: "s", description: "" },
    ] },
    { id: "corpus", title: "Corpus", kind: "corpus", tools: [
      { id: "search_corpus", title: "c", description: "" },
    ] },
    { id: "mcp:firecrawl", title: "firecrawl", kind: "mcp", server: "firecrawl", tools: [
      { id: "mcp_firecrawl_search", title: "f", description: "" },
    ] },
  ],
};

describe("tool selection toggles", () => {
  it("starts with everything enabled", () => {
    const sel = emptyToolSelection();
    expect(isGroupEnabled(sel, "builtin")).toBe(true);
    expect(isToolEnabled(sel, "builtin", "outline")).toBe(true);
    expect(countActiveTools(catalog, sel)).toBe(4);
  });

  it("toggles a group off and back on (immutably)", () => {
    const sel0 = emptyToolSelection();
    const off = toggleGroup(sel0, "corpus", false);
    expect(isGroupEnabled(off, "corpus")).toBe(false);
    expect(isToolEnabled(off, "corpus", "search_corpus")).toBe(false);
    expect(sel0.disabledGroups).toEqual([]); // original untouched
    const on = toggleGroup(off, "corpus", true);
    expect(isGroupEnabled(on, "corpus")).toBe(true);
  });

  it("toggles a single tool", () => {
    const sel = toggleTool(emptyToolSelection(), "search_nodes", false);
    expect(isToolEnabled(sel, "builtin", "search_nodes")).toBe(false);
    expect(isToolEnabled(sel, "builtin", "outline")).toBe(true);
    expect(countActiveTools(catalog, sel)).toBe(3);
  });
});

describe("resolveDisabledToolIds", () => {
  it("expands a disabled group into all its tool ids", () => {
    const sel = toggleGroup(emptyToolSelection(), "builtin", false);
    const ids = resolveDisabledToolIds(catalog, sel).sort();
    expect(ids).toEqual(["outline", "search_nodes"]);
  });

  it("unions group-off + per-tool-off", () => {
    let sel = toggleGroup(emptyToolSelection(), "corpus", false);
    sel = toggleTool(sel, "outline", false);
    const ids = resolveDisabledToolIds(catalog, sel).sort();
    expect(ids).toEqual(["outline", "search_corpus"]);
  });
});

describe("enabledMcpServers", () => {
  it("lists mcp servers whose group is enabled", () => {
    expect(enabledMcpServers(catalog, emptyToolSelection())).toEqual(["firecrawl"]);
    const off = toggleGroup(emptyToolSelection(), "mcp:firecrawl", false);
    expect(enabledMcpServers(catalog, off)).toEqual([]);
  });
});

describe("normalizeToolSelection", () => {
  it("fills in missing arrays", () => {
    expect(normalizeToolSelection(undefined)).toEqual({ disabledGroups: [], disabledTools: [] });
    expect(normalizeToolSelection({ disabledTools: ["x"] } as any)).toEqual({ disabledGroups: [], disabledTools: ["x"] });
  });
});
