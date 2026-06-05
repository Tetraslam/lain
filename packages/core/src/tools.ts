// The default node toolbelt — the capabilities every node-agent gets while
// expanding. This is what turns a node from a one-shot completion into a
// collaborator: it can read and search any node in the graph (not just its
// ancestors), retrieve from the multimodal corpus, and link itself to related
// work elsewhere in the tree.
//
// Extensions and MCP servers contribute additional tools on top of these via
// the same `LainTool` shape.

import { Graph } from "./graph.js";
import { Corpus, tokenize } from "./corpus.js";
import type { Exploration, LainNode, ToolSpec, ToolResultBlock } from "@lain/shared";

/** Everything a tool handler can reach. */
export interface LainToolContext {
  graph: Graph;
  corpus: Corpus | null;
  exploration: Exploration;
  /** The node currently being expanded (so tools can act relative to it). */
  currentNodeId: string;
}

/** Outcome of running a tool: content blocks back to the model + a log summary. */
export interface LainToolOutcome {
  content: ToolResultBlock[];
  isError?: boolean;
  summary?: string;
}

/** A tool: its wire spec plus an executable handler. */
export interface LainTool {
  spec: ToolSpec;
  handler: (input: Record<string, unknown>, ctx: LainToolContext) => Promise<LainToolOutcome>;
}

function text(s: string): LainToolOutcome {
  return { content: [{ type: "text", text: s }], summary: s.slice(0, 100) };
}

function snippet(s: string | null, n = 280): string {
  if (!s) return "";
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? clean.slice(0, n) + "…" : clean;
}

/**
 * Build the executable tool context for a node expansion.
 */
export function buildToolContext(args: {
  graph: Graph;
  corpus: Corpus | null;
  exploration: Exploration;
  currentNodeId: string;
}): LainToolContext {
  return args;
}

/**
 * The default toolbelt for node generation. `hasCorpus` controls whether the
 * corpus tools are advertised (no point offering them when nothing's ingested).
 */
export function buildNodeTools(opts: { hasCorpus: boolean }): LainTool[] {
  const tools: LainTool[] = [
    {
      spec: {
        name: "outline",
        description:
          "List the current exploration's nodes as an indented outline (id, depth, title). Use this to understand what already exists across the whole graph before writing, so you can diverge or build on sibling/cousin branches.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      async handler(_input, ctx) {
        const nodes = ctx.graph
          .getAllNodes(ctx.exploration.id)
          .filter((n) => n.status === "complete" && n.id !== ctx.currentNodeId);
        if (nodes.length === 0) return text("(no other completed nodes yet)");
        const lines = nodes
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((n) => `${"  ".repeat(n.depth)}- [${n.id}] ${n.title ?? "(untitled)"}`);
        return text(lines.join("\n"));
      },
    },
    {
      spec: {
        name: "read_node",
        description:
          "Read the full title and content of any node in the exploration by id. Use it to build on, contrast with, or avoid duplicating another branch's ideas.",
        inputSchema: {
          type: "object",
          properties: { node_id: { type: "string", description: "The node id, e.g. 'root-2-1'." } },
          required: ["node_id"],
          additionalProperties: false,
        },
      },
      async handler(input, ctx) {
        const node = ctx.graph.getNode(String(input.node_id));
        if (!node) return { ...text(`No node with id "${input.node_id}".`), isError: true };
        const header = `# ${node.title ?? "(untitled)"} [${node.id}]`;
        return text(`${header}\n\n${node.content ?? "(no content)"}`);
      },
    },
    {
      spec: {
        name: "search_nodes",
        description:
          "Keyword-search the content of all completed nodes in the exploration. Returns ranked matches with id, title, and a snippet.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number", description: "Max results (default 5)." },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      async handler(input, ctx) {
        const limit = Math.max(1, Math.min(20, Number(input.limit) || 5));
        const hits = searchNodes(ctx.graph.getAllNodes(ctx.exploration.id), String(input.query), ctx.currentNodeId, limit);
        if (hits.length === 0) return text(`No nodes matched "${input.query}".`);
        const out = hits
          .map((h) => `[${h.node.id}] ${h.node.title ?? "(untitled)"}\n  ${snippet(h.node.content)}`)
          .join("\n\n");
        return text(out);
      },
    },
    {
      spec: {
        name: "link_to_node",
        description:
          "Create a cross-link from the node you are currently writing to another node you found related. Use sparingly, only for genuinely meaningful connections across branches.",
        inputSchema: {
          type: "object",
          properties: {
            target_node_id: { type: "string" },
            relationship: { type: "string", description: "Short label describing the connection." },
          },
          required: ["target_node_id", "relationship"],
          additionalProperties: false,
        },
      },
      async handler(input, ctx) {
        const target = ctx.graph.getNode(String(input.target_node_id));
        if (!target) return { ...text(`No node "${input.target_node_id}" to link to.`), isError: true };
        if (target.id === ctx.currentNodeId) return { ...text("Cannot link a node to itself."), isError: true };
        ctx.graph.addCrosslink(ctx.currentNodeId, target.id, String(input.relationship), true);
        return text(`Linked ${ctx.currentNodeId} ↔ ${target.id} ("${input.relationship}").`);
      },
    },
  ];

  if (opts.hasCorpus) {
    tools.push(
      {
        spec: {
          name: "search_corpus",
          description:
            "Search the user's ingested source material (their files, notes, data, documents) for relevant passages. ALWAYS consult this before writing — the user dumped this material precisely so you would ground your ideas in it.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              limit: { type: "number", description: "Max passages (default 6)." },
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
        async handler(input, ctx) {
          if (!ctx.corpus) return text("(no corpus available)");
          const hits = ctx.corpus.search(ctx.exploration.id, String(input.query), Math.max(1, Math.min(20, Number(input.limit) || 6)));
          if (hits.length === 0) return text(`No source material matched "${input.query}".`);
          const out = hits
            .map((h, i) => `(${i + 1}) from "${h.sourceName}" [${h.sourceKind}]\n${snippet(h.chunk.text, 500)}`)
            .join("\n\n");
          return text(out);
        },
      },
      {
        spec: {
          name: "list_corpus_sources",
          description: "List the names and kinds of all source material the user has ingested.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
        async handler(_input, ctx) {
          if (!ctx.corpus) return text("(no corpus available)");
          const sources = ctx.corpus.listSources(ctx.exploration.id);
          if (sources.length === 0) return text("(no sources ingested)");
          return text(sources.map((s) => `- ${s.name} [${s.kind}]`).join("\n"));
        },
      }
    );
  }

  return tools;
}

// ---------------------------------------------------------------------------
// Node search (lightweight keyword scoring over node content)
// ---------------------------------------------------------------------------

interface NodeHit {
  node: LainNode;
  score: number;
}

function searchNodes(nodes: LainNode[], query: string, excludeId: string, limit: number): NodeHit[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const termSet = new Set(terms);
  const scored: NodeHit[] = [];
  for (const node of nodes) {
    if (node.id === excludeId || node.status !== "complete") continue;
    const haystack = tokenize(`${node.title ?? ""} ${node.content ?? ""}`);
    if (haystack.length === 0) continue;
    let score = 0;
    for (const t of haystack) if (termSet.has(t)) score++;
    // light boost for title matches
    for (const t of tokenize(node.title ?? "")) if (termSet.has(t)) score += 2;
    if (score > 0) scored.push({ node, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
