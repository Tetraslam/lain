// Remote MCP (Model Context Protocol) client.
//
// Connects to remote MCP servers over the Streamable HTTP transport, lists
// their tools, and adapts each into a LainTool that node-agents can call
// during agentic generation. This is how lain borrows the entire MCP tool
// ecosystem (web search/scrape, databases, SaaS APIs, …) without bespoke code.
//
// Only remote (HTTP) servers are supported — by design.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig, ToolResultBlock, ImageFormat } from "@lain/shared";
import type { LainTool } from "./tools.js";

export interface McpConnection {
  /** Server name (local alias). */
  name: string;
  /** Tools exposed by this server, adapted to lain's tool shape. */
  tools: LainTool[];
  close: () => Promise<void>;
}

/** Sanitize a tool name into the charset model APIs accept ([a-zA-Z0-9_-], <=64). */
function toolId(server: string, tool: string): string {
  const raw = `mcp_${server}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  return raw.length > 64 ? raw.slice(0, 64) : raw;
}

const IMAGE_MIME_TO_FORMAT: Record<string, ImageFormat> = {
  "image/png": "png", "image/jpeg": "jpeg", "image/gif": "gif", "image/webp": "webp",
};

/** Map MCP tool-result content blocks into lain ToolResultBlocks. */
function mapMcpContent(content: unknown): ToolResultBlock[] {
  if (!Array.isArray(content)) return [{ type: "text", text: typeof content === "string" ? content : JSON.stringify(content) }];
  const out: ToolResultBlock[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === "text" && typeof block.text === "string") {
      out.push({ type: "text", text: block.text });
    } else if (block.type === "image" && typeof block.data === "string") {
      const fmt = IMAGE_MIME_TO_FORMAT[String(block.mimeType)] ?? "png";
      out.push({ type: "image", format: fmt, data: block.data });
    } else if (block.type === "resource" && block.resource) {
      const r = block.resource as Record<string, unknown>;
      out.push({ type: "text", text: typeof r.text === "string" ? r.text : JSON.stringify(r) });
    } else {
      out.push({ type: "text", text: JSON.stringify(block) });
    }
  }
  return out.length > 0 ? out : [{ type: "text", text: "(empty tool result)" }];
}

/**
 * Connect to a single remote MCP server and adapt its tools to LainTools.
 * Throws on connection failure (callers decide whether to skip or surface).
 */
export async function connectMcpServer(name: string, config: McpServerConfig): Promise<McpConnection> {
  const client = new Client({ name: "lain", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: config.headers ? { headers: config.headers } : undefined,
  });
  await client.connect(transport);

  const listed = await client.listTools();
  const tools: LainTool[] = (listed.tools ?? []).map((t) => {
    const originalName = t.name;
    return {
      spec: {
        name: toolId(name, originalName),
        description: `[${name}] ${t.description ?? originalName}`,
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
      },
      async handler(input) {
        try {
          const result = await client.callTool({ name: originalName, arguments: input });
          return {
            content: mapMcpContent(result.content),
            isError: result.isError === true,
            summary: `${name}:${originalName}`,
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `MCP tool "${originalName}" failed: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      },
    };
  });

  return {
    name,
    tools,
    close: async () => { try { await client.close(); } catch { /* ignore */ } },
  };
}

export interface McpPool {
  tools: LainTool[];
  connections: McpConnection[];
  close: () => Promise<void>;
  errors: { name: string; error: string }[];
}

/**
 * Connect to all enabled MCP servers in a config map. Failures are collected in
 * `errors` rather than thrown, so one bad server doesn't abort an exploration.
 */
export async function connectMcpServers(servers: Record<string, McpServerConfig> | undefined): Promise<McpPool> {
  const connections: McpConnection[] = [];
  const errors: { name: string; error: string }[] = [];
  for (const [name, cfg] of Object.entries(servers ?? {})) {
    if (cfg.disabled) continue;
    try {
      connections.push(await connectMcpServer(name, cfg));
    } catch (err) {
      errors.push({ name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return {
    connections,
    tools: connections.flatMap((c) => c.tools),
    errors,
    close: async () => { await Promise.all(connections.map((c) => c.close())); },
  };
}
