// Tool catalog assembly.
//
// Produces a uniform, render-ready description of every tool available to
// node-agents — built-in, corpus, extension (lens), and MCP — so the CLI, TUI,
// and web can all show and toggle the same thing. MCP groups can be probed
// (connect + list tools) or listed lazily (server names only).

import type { McpServerConfig, ToolCatalog, ToolGroup, ToolInfo } from "@lain/shared";
import { BUILTIN_TOOL_INFO, CORPUS_TOOL_INFO } from "./tools.js";
import { connectMcpServers, type McpPool } from "./mcp.js";

export interface BuildCatalogInput {
  /** Whether to include the corpus group as active (still listed if false). */
  hasCorpus?: boolean;
  /** Extension tool groups (kind "extension"), supplied by the caller's registry. */
  extensionGroups?: ToolGroup[];
  /** Configured MCP servers. */
  mcpServers?: Record<string, McpServerConfig>;
  /** When true, connect to each server and enumerate its real tools. */
  probeMcp?: boolean;
}

export interface BuildCatalogResult {
  catalog: ToolCatalog;
  /** Live MCP connections, present only when `probeMcp` was set. Caller must close(). */
  mcpPool?: McpPool;
}

/**
 * Assemble the full tool catalog. When `probeMcp` is set, MCP servers are
 * connected and their tools enumerated (the live pool is returned so a run can
 * reuse the connections instead of reconnecting).
 */
export async function buildToolCatalog(input: BuildCatalogInput): Promise<BuildCatalogResult> {
  const groups: ToolGroup[] = [
    {
      id: "builtin",
      title: "Built-in graph tools",
      kind: "builtin",
      description: "Read, search, and link across the idea graph; share findings between branches.",
      tools: BUILTIN_TOOL_INFO,
    },
    {
      id: "corpus",
      title: "Corpus retrieval",
      kind: "corpus",
      description: input.hasCorpus
        ? "Ground generation in the user's ingested source material."
        : "Available once source material is ingested into the exploration.",
      tools: CORPUS_TOOL_INFO,
    },
    ...(input.extensionGroups ?? []),
  ];

  let mcpPool: McpPool | undefined;
  const servers = input.mcpServers ?? {};
  const serverNames = Object.keys(servers);

  if (input.probeMcp && serverNames.length > 0) {
    // Connect only to non-disabled servers; disabled ones are listed inert.
    const toProbe: Record<string, McpServerConfig> = {};
    for (const [name, cfg] of Object.entries(servers)) if (!cfg.disabled) toProbe[name] = cfg;
    mcpPool = await connectMcpServers(toProbe);
    const byServer = new Map<string, ToolInfo[]>();
    for (const conn of mcpPool.connections) {
      byServer.set(
        conn.name,
        conn.tools.map((t) => ({ id: t.spec.name, title: t.spec.name, description: t.spec.description })),
      );
    }
    const errorByServer = new Map(mcpPool.errors.map((e) => [e.name, e.error]));
    for (const name of serverNames) {
      const cfg = servers[name];
      groups.push({
        id: `mcp:${name}`,
        title: name,
        kind: "mcp",
        server: name,
        description: cfg.disabled ? "Disabled in config." : redactUrl(cfg.url),
        probed: !cfg.disabled && !errorByServer.has(name),
        error: errorByServer.get(name),
        tools: byServer.get(name) ?? [],
      });
    }
  } else {
    for (const name of serverNames) {
      const cfg = servers[name];
      groups.push({
        id: `mcp:${name}`,
        title: name,
        kind: "mcp",
        server: name,
        description: redactUrl(cfg.url),
        probed: false,
        tools: [],
      });
    }
  }

  return { catalog: { groups }, mcpPool };
}

function redactUrl(url: string): string {
  return url
    .replace(/(fc-|sk-|key-|tok_|Bearer\s+)[A-Za-z0-9_-]{6,}/gi, "$1***")
    .replace(/\/[A-Za-z0-9_-]{24,}(\/|$)/g, "/***$1");
}
