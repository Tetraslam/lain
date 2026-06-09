/**
 * @lain/shared — tool catalog + selection model.
 *
 * The agent substrate's toolbelt is assembled from several sources: the built-in
 * node tools, corpus-retrieval tools, each active extension (lens), and each
 * configured MCP server. This module defines the wire-shape for *describing*
 * that catalog (so every surface can render it identically) and a pure selection
 * model layered on top: which groups/tools are enabled.
 *
 * Selection is a delta from "everything on": a tool is active unless its group
 * is disabled or the tool itself is disabled. Config stores the default
 * selection; a run may override it (ephemerally, or saved back as the default).
 */

export type ToolGroupKind = "builtin" | "corpus" | "extension" | "mcp";

export interface ToolInfo {
  /** Stable, fully-qualified tool id (matches the runtime ToolSpec.name). */
  id: string;
  title: string;
  description: string;
}

export interface ToolGroup {
  /** Stable group id: "builtin", "corpus", "ext:<name>", "mcp:<server>". */
  id: string;
  title: string;
  kind: ToolGroupKind;
  description?: string;
  tools: ToolInfo[];
  /** For mcp groups: whether the catalog actually probed the server's tools. */
  probed?: boolean;
  /** For mcp groups: a connection error if probing failed. */
  error?: string;
  /** For mcp groups: the underlying server name. */
  server?: string;
}

export interface ToolCatalog {
  groups: ToolGroup[];
}

/** A delta from "everything enabled". */
export interface ToolSelection {
  /** Group ids that are turned off entirely. */
  disabledGroups: string[];
  /** Individual tool ids that are turned off (within otherwise-enabled groups). */
  disabledTools: string[];
}

export function emptyToolSelection(): ToolSelection {
  return { disabledGroups: [], disabledTools: [] };
}

/** Normalize a possibly-partial selection (e.g. from older config) to a full one. */
export function normalizeToolSelection(sel: Partial<ToolSelection> | null | undefined): ToolSelection {
  return {
    disabledGroups: Array.isArray(sel?.disabledGroups) ? [...sel!.disabledGroups] : [],
    disabledTools: Array.isArray(sel?.disabledTools) ? [...sel!.disabledTools] : [],
  };
}

export function isGroupEnabled(sel: ToolSelection, groupId: string): boolean {
  return !sel.disabledGroups.includes(groupId);
}

export function isToolEnabled(sel: ToolSelection, groupId: string, toolId: string): boolean {
  return isGroupEnabled(sel, groupId) && !sel.disabledTools.includes(toolId);
}

/** Immutably toggle a whole group on/off. */
export function toggleGroup(sel: ToolSelection, groupId: string, enabled: boolean): ToolSelection {
  const disabledGroups = sel.disabledGroups.filter((g) => g !== groupId);
  if (!enabled) disabledGroups.push(groupId);
  return { ...sel, disabledGroups };
}

/** Immutably toggle a single tool on/off. */
export function toggleTool(sel: ToolSelection, toolId: string, enabled: boolean): ToolSelection {
  const disabledTools = sel.disabledTools.filter((t) => t !== toolId);
  if (!enabled) disabledTools.push(toolId);
  return { ...sel, disabledTools };
}

/**
 * Resolve a selection against a catalog into the flat set of tool ids that
 * should be DISABLED at runtime (covers both group-off and per-tool-off). The
 * orchestrator filters the assembled toolbelt by this set.
 */
export function resolveDisabledToolIds(catalog: ToolCatalog, sel: ToolSelection): string[] {
  const disabled = new Set<string>(sel.disabledTools);
  for (const g of catalog.groups) {
    if (!isGroupEnabled(sel, g.id)) for (const tool of g.tools) disabled.add(tool.id);
  }
  return [...disabled];
}

/** MCP server names whose group is enabled (i.e. should be connected for the run). */
export function enabledMcpServers(catalog: ToolCatalog, sel: ToolSelection): string[] {
  return catalog.groups
    .filter((g) => g.kind === "mcp" && isGroupEnabled(sel, g.id) && g.server)
    .map((g) => g.server!);
}

/** Count of active tools across the catalog under a selection. */
export function countActiveTools(catalog: ToolCatalog, sel: ToolSelection): number {
  let n = 0;
  for (const g of catalog.groups) {
    if (!isGroupEnabled(sel, g.id)) continue;
    for (const tool of g.tools) if (!sel.disabledTools.includes(tool.id)) n++;
  }
  return n;
}
