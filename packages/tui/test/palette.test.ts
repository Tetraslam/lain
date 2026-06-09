import { describe, it, expect } from "vitest";
import {
  fuzzyMatch,
  availableCommands,
  rankCommands,
  groupRanked,
  allCommands,
  type PaletteHost,
} from "../src/palette.js";

function host(overrides: Partial<PaletteHost> = {}): PaletteHost {
  const noop = () => {};
  return {
    context: "exploring",
    hasExploration: true,
    hasSelectedNode: true,
    selectedNodeTitle: "A Node",
    selectedNodeId: "root-1",
    isRootSelected: false,
    hasCorpus: false,
    hasMission: false,
    hasSynthesis: false,
    branchN: 3,
    openNode: noop, editNode: noop, pruneNode: noop, extendNode: noop, redirectNode: noop,
    linkNode: noop, graphView: noop, backToTree: noop, scrollTop: noop, newExploration: noop,
    openExploration: noop, synthesize: noop, viewSynthesis: noop,
    resumeExploration: noop, viewMission: noop, exportMarkdown: noop, exportCanvas: noop,
    syncObsidian: noop, addCorpus: noop, searchCorpus: noop, backToHome: noop, checkUpdate: noop,
    help: noop, quit: noop,
    ...overrides,
  };
}

describe("fuzzyMatch", () => {
  it("matches a subsequence and returns positions in the title", () => {
    const r = fuzzyMatch("synth", "Synthesize");
    expect(r).not.toBeNull();
    expect(r!.positions.length).toBe(5);
    expect(r!.positions[0]).toBe(0);
  });
  it("returns null when not a subsequence", () => {
    expect(fuzzyMatch("zzz", "Synthesize")).toBeNull();
  });
  it("empty query matches everything with score 0", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] });
  });
  it("scores a prefix/word-boundary match higher than a scattered one", () => {
    const prefix = fuzzyMatch("ext", "Extend node")!;
    const scattered = fuzzyMatch("ext", "context reset")!;
    expect(prefix.score).toBeGreaterThan(scattered.score);
  });
  it("matches against extra keywords but only reports title positions", () => {
    const r = fuzzyMatch("regenerate", "Redirect node", "regenerate rewrite");
    expect(r).not.toBeNull();
    expect(r!.positions.every((p) => p < "Redirect node".length)).toBe(true);
  });
});

describe("availableCommands (context gating)", () => {
  it("home (no exploration) hides node ops, offers New exploration", () => {
    const ids = availableCommands(host({ context: "home", hasExploration: false, hasSelectedNode: false })).map((c) => c.id);
    expect(ids).toContain("exp.new");
    expect(ids).not.toContain("node.prune");
    expect(ids).not.toContain("nav.graph"); // needs an exploration
    expect(ids).not.toContain("syn.run");
  });
  it("exploring with a non-root node exposes node ops", () => {
    const ids = availableCommands(host()).map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["node.open", "node.extend", "node.prune", "node.redirect", "nav.graph", "syn.run"]));
  });
  it("hides prune/redirect when the root is selected", () => {
    const ids = availableCommands(host({ isRootSelected: true })).map((c) => c.id);
    expect(ids).not.toContain("node.prune");
    expect(ids).not.toContain("node.redirect");
    expect(ids).toContain("node.extend"); // root can still extend
  });
  it("gates mission, corpus search, synthesis view, and edit on state", () => {
    expect(availableCommands(host()).map((c) => c.id)).not.toContain("exp.mission");
    expect(availableCommands(host({ hasMission: true })).map((c) => c.id)).toContain("exp.mission");
    expect(availableCommands(host()).map((c) => c.id)).not.toContain("corpus.search");
    expect(availableCommands(host({ hasCorpus: true })).map((c) => c.id)).toContain("corpus.search");
    expect(availableCommands(host({ hasSynthesis: true })).map((c) => c.id)).toContain("syn.view");
    expect(availableCommands(host({ context: "reading" })).map((c) => c.id)).toContain("node.edit");
  });
  it("every command has a unique id and a runnable action", () => {
    const cmds = allCommands();
    const ids = cmds.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of cmds) expect(typeof c.run).toBe("function");
  });
});

describe("rankCommands", () => {
  it("ranks the best fuzzy match first when searching", () => {
    const ranked = rankCommands(host(), "extend");
    expect(ranked[0].command.id).toBe("node.extend");
  });
  it("finds a command by keyword synonym", () => {
    const ranked = rankCommands(host({ isRootSelected: false }), "regenerate");
    expect(ranked[0].command.id).toBe("node.redirect");
  });
  it("excludes unavailable commands from results", () => {
    const ranked = rankCommands(host({ hasMission: false }), "mission");
    expect(ranked.find((r) => r.command.id === "exp.mission")).toBeUndefined();
  });
  it("empty query returns grouped registry order (node group before app)", () => {
    const ranked = rankCommands(host(), "");
    const groups = groupRanked(ranked).map((g) => g.group);
    expect(groups.indexOf("node")).toBeLessThan(groups.indexOf("app"));
  });
});

describe("groupRanked", () => {
  it("buckets ranked commands by group preserving order", () => {
    const sections = groupRanked(rankCommands(host(), ""));
    const nodeSection = sections.find((s) => s.group === "node")!;
    expect(nodeSection.items.length).toBeGreaterThan(0);
    expect(nodeSection.items.every((r) => r.command.group === "node")).toBe(true);
  });
});
