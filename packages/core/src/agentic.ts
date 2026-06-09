// Agentic node generation — the substrate in action.
//
// Instead of a single completion, a node is expanded by an agent that can see
// the whole graph, retrieve from the user's corpus, link across branches, and
// (via extensions/MCP) call domain tools. This module builds the prompt + tool
// context and drives the AgentRunner loop, returning a GenerateResponse so the
// orchestrator's storage/events/hooks flow is unchanged.

import { runAgent, type ToolDispatch } from "@lain/agents";
import type {
  AgentProvider,
  AgentStepHandler,
  Exploration,
  ExtensionTool,
  ExtensionToolContext,
  GenerateResponse,
  LainNode,
  Mission,
  ToolResultBlock,
  ToolSpec,
} from "@lain/shared";
import { userText } from "@lain/shared";
import { Graph } from "./graph.js";
import { Storage } from "./storage.js";
import { Corpus } from "./corpus.js";
import { buildNodeTools, buildToolContext, type LainTool } from "./tools.js";

export interface AgenticGenerateDeps {
  agent: AgentProvider;
  graph: Graph;
  storage: Storage;
  corpus: Corpus | null;
  exploration: Exploration;
  /** Optional mission (intent + success criteria) injected into the agent. */
  mission?: Mission | null;
  /** Extension/mission system-prompt fragment. */
  extensionSystemPrompt?: string;
  /** Additional tools contributed by extensions / MCP servers. */
  extraTools?: LainTool[];
  /** Extension-defined tools (adapted to LainTools with a corpus/graph/agent context). */
  extensionTools?: ExtensionTool[];
  /** Tool ids to drop from the assembled toolbelt (per-run/config selection). */
  disabledTools?: string[];
  maxSteps?: number;
  maxTokens?: number;
  onStep?: AgentStepHandler;
  signal?: AbortSignal;
}

const SUBSTRATE_SYSTEM = `You are a node-agent inside lain, a graph-based ideation engine. You expand exactly ONE node of an evolving idea graph.

Your job:
- Develop THIS node's assigned direction into rich, substantive, original, intellectually honest content.
- Meaningfully DIVERGE from sibling branches — do not restate what they cover.
- BUILD ON the wider graph and the user's source material when relevant.

How to work (use your tools before writing):
- Call \`outline\` to see what already exists across the whole graph.
- Call \`search_corpus\` whenever source material is available — the user provided it precisely so your ideas are grounded in their world/data, not generic.
- Call \`search_nodes\`/\`read_node\` to study adjacent branches you should diverge from or build on.
- If you discover a genuinely meaningful connection to another branch, call \`link_to_node\` (sparingly).

When you are ready, you MUST finish by calling the \`submit_node\` tool exactly once with:
- title: a vivid, specific title (no "#", just the title text).
- content: the node body in clean markdown (no title heading, no meta-commentary about your process).
Do not write the node as prose in a normal message — always deliver it via \`submit_node\`.`;

function buildTaskMessage(node: LainNode, graph: Graph, exploration: Exploration): string {
  const ancestors = graph.getAncestorChain(node.id);
  const siblings = graph.getSiblings(node.id).filter((s) => s.status === "complete");

  const parts: string[] = [];
  parts.push(`Exploration seed: "${exploration.seed}"`);

  if (ancestors.length > 0) {
    const chain = ancestors
      .map((a) => `  - [${a.id}] ${a.title ?? "(untitled)"}`)
      .join("\n");
    parts.push(`Ancestor path (root → parent):\n${chain}`);
    const parent = ancestors[ancestors.length - 1];
    if (parent.content) {
      const trimmed = parent.content.replace(/\s+/g, " ").trim().slice(0, 800);
      parts.push(`Immediate parent's content (excerpt):\n${trimmed}${parent.content.length > 800 ? "…" : ""}`);
    }
  }

  if (siblings.length > 0) {
    const sibs = siblings.map((s) => `  - [${s.id}] ${s.title ?? "(untitled)"}`).join("\n");
    parts.push(`Sibling branches you must diverge from:\n${sibs}`);
  }

  parts.push(
    node.planSummary
      ? `YOUR ASSIGNED DIRECTION for this node (${node.id}):\n${node.planSummary}`
      : `This is node ${node.id}. Develop a distinct, valuable direction from the seed/parent.`
  );

  parts.push(`Now research with your tools, then write the final node.`);
  return parts.join("\n\n");
}

/** Run the agentic loop to expand a single node into a GenerateResponse. */
export async function generateNodeAgentic(
  node: LainNode,
  deps: AgenticGenerateDeps
): Promise<GenerateResponse> {
  const hasCorpus = deps.corpus ? !deps.corpus.isEmpty(deps.exploration.id) : false;
  const adaptedExtensionTools = (deps.extensionTools ?? []).map((et) =>
    adaptExtensionTool(et, deps.agent)
  );
  const disabled = new Set(deps.disabledTools ?? []);
  const tools: LainTool[] = [
    ...buildNodeTools({ hasCorpus }),
    ...adaptedExtensionTools,
    ...(deps.extraTools ?? []),
  ].filter((t) => !disabled.has(t.spec.name));

  const ctx = buildToolContext({
    graph: deps.graph,
    storage: deps.storage,
    corpus: deps.corpus,
    exploration: deps.exploration,
    currentNodeId: node.id,
  });

  const toolByName = new Map(tools.map((t) => [t.spec.name, t]));

  // The agent delivers its final node via `submit_node`. Capturing it through a
  // tool (rather than parsing free-form prose) cleanly separates the node from
  // the agent's interleaved reasoning. Submitting aborts the loop so we don't
  // pay for an extra round-trip.
  let submitted: { title: string; content: string } | null = null;
  const abort = new AbortController();
  const linkedSignals = mergeSignals(deps.signal, abort.signal);

  const submitTool: ToolSpec = {
    name: "submit_node",
    description:
      "Deliver the FINAL node. Call this exactly once when your research and writing are complete.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Vivid, specific title (no leading '#')." },
        content: { type: "string", description: "Node body in clean markdown." },
      },
      required: ["title", "content"],
      additionalProperties: false,
    },
  };

  const dispatch: ToolDispatch = async (call) => {
    if (call.name === "submit_node") {
      submitted = {
        title: String(call.input.title ?? "").replace(/^#+\s*/, "").trim() || "Untitled",
        content: String(call.input.content ?? "").trim(),
      };
      abort.abort();
      return { content: [{ type: "text", text: "Node saved." }] as ToolResultBlock[], summary: submitted.title };
    }
    const tool = toolByName.get(call.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${call.name}` }] as ToolResultBlock[],
        isError: true,
      };
    }
    const outcome = await tool.handler(call.input, ctx);
    return { content: outcome.content, isError: outcome.isError, summary: outcome.summary };
  };

  let system = SUBSTRATE_SYSTEM;
  if (deps.mission && deps.mission.assertions.length > 0) {
    const contract = deps.mission.assertions.map((a) => `  ${a.id}. ${a.text}`).join("\n");
    system += `\n\n--- Mission contract ---\nThis exploration pursues a goal, not just a topic.\nIntent: ${deps.mission.intent}\nThe whole graph is validated against this contract:\n${contract}\n\nAdvance one or more of these assertions with THIS node, concretely enough that an independent validator could mark it met. Record durable discoveries with note_finding so other branches build on them, and read_findings before writing.`;
  }
  if (deps.extensionSystemPrompt) {
    system += `\n\n--- Domain guidance ---\n${deps.extensionSystemPrompt}`;
  }

  const toolSpecs = [...tools.map((t) => t.spec), submitTool];
  let messages = [userText(buildTaskMessage(node, deps.graph, deps.exploration))];
  let result = await runAgent({
    provider: deps.agent,
    system,
    messages,
    tools: toolSpecs,
    dispatch,
    maxSteps: deps.maxSteps ?? 10,
    maxTokens: deps.maxTokens,
    onEvent: deps.onStep,
    signal: linkedSignals,
  });

  // Models sometimes end their turn announcing intent instead of actually
  // calling submit_node. Nudge them to deliver the node via the tool.
  for (let nudge = 0; !submitted && nudge < 2 && !deps.signal?.aborted; nudge++) {
    messages = [
      ...result.messages,
      userText(
        "You ended your turn without calling submit_node. Do not write the node as prose. Call the submit_node tool now with the final `title` and `content`."
      ),
    ];
    result = await runAgent({
      provider: deps.agent,
      system,
      messages,
      tools: toolSpecs,
      dispatch,
      maxSteps: 2,
      maxTokens: deps.maxTokens,
      onEvent: deps.onStep,
      signal: linkedSignals,
    });
  }

  if (submitted) {
    return {
      title: (submitted as { title: string }).title,
      content: (submitted as { content: string }).content,
      model: deps.agent.modelId,
      provider: deps.agent.providerName,
    };
  }
  // Fallback: the agent never called submit_node (e.g. hit the step budget).
  return parseFinalNode(result.text, deps.agent.modelId, deps.agent.providerName);
}

/**
 * Adapt an extension-defined tool into a LainTool. Builds the dependency-light
 * ExtensionToolContext (graph reads, corpus search, sub-agent calls) from the
 * live LainToolContext the runner provides for the current node.
 */
function adaptExtensionTool(et: ExtensionTool, agent: AgentProvider): LainTool {
  return {
    spec: et.spec,
    async handler(input, ctx) {
      const extCtx: ExtensionToolContext = {
        exploration: ctx.exploration,
        currentNodeId: ctx.currentNodeId,
        readNode: (id) => {
          const n = ctx.graph.getNode(id);
          return n ? { id: n.id, title: n.title, content: n.content } : null;
        },
        searchCorpus: (query, limit) =>
          ctx.corpus
            ? ctx.corpus.search(ctx.exploration.id, query, limit ?? 6).map((h) => ({
                sourceName: h.sourceName,
                text: h.chunk.text,
              }))
            : [],
        callAgent: (system, user, maxTokens) => agent.generateRaw(system, user, maxTokens),
      };
      return et.handler(input, extCtx);
    },
  };
}

/** Combine an optional external signal with our internal abort signal. */
function mergeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (a.aborted || b.aborted) controller.abort();
  a.addEventListener("abort", onAbort);
  b.addEventListener("abort", onAbort);
  return controller.signal;
}

function parseFinalNode(
  text: string,
  model: string,
  provider: GenerateResponse["provider"]
): GenerateResponse {
  const cleaned = text.trim();
  const lines = cleaned.split("\n");
  // Prefer the first markdown H1 (skips any leading reasoning the model emitted);
  // otherwise fall back to the first non-empty line.
  let titleIdx = lines.findIndex((l) => /^#\s+\S/.test(l.trim()));
  if (titleIdx === -1) titleIdx = lines.findIndex((l) => l.trim().length > 0);
  if (titleIdx === -1) titleIdx = 0;
  const title = (lines[titleIdx] ?? "Untitled").trim().replace(/^#+\s*/, "") || "Untitled";
  const content = lines.slice(titleIdx + 1).join("\n").trim();
  return { title, content, model, provider };
}
