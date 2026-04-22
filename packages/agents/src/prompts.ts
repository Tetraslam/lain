import type {
  GenerateRequest,
  PlanRequest,
  SynthesizeRequest,
  SynthesizeResponse,
  SynthesisAnnotationData,
  LainNode,
  PlanDetail,
  Provider,
  AnnotationType,
} from "@lain/shared";

/**
 * Build the system + user prompts for node content generation.
 */
export function buildGeneratePrompt(request: GenerateRequest): {
  system: string;
  user: string;
} {
  const { node, ancestors, siblings, exploration } = request;

  const system = [
    "You are an ideation engine. You expand ideas into rich, detailed explorations.",
    "Your job is to take a direction/theme and develop it into a substantive piece of writing.",
    "",
    "Rules:",
    "- Be specific and concrete, not vague or generic",
    "- Develop the idea with real depth — examples, mechanisms, implications",
    "- Your output should be meaningfully different from your siblings (other branches)",
    "- Write in markdown. Start with the main content directly (no heading — that's added separately).",
    "- Aim for 200-500 words of substantive content",
    request.extensionSystemPrompt || "",
  ]
    .filter(Boolean)
    .join("\n");

  const ancestorChain = ancestors
    .map(
      (a) =>
        `[Depth ${a.depth}] ${a.title || "Root"}: ${truncate(a.content || a.explorationId, 300)}`
    )
    .join("\n\n");

  const siblingContext =
    siblings.length > 0
      ? siblings
          .map(
            (s) =>
              `- ${s.title}: ${truncate(s.content || "", 150)}`
          )
          .join("\n")
      : "None yet.";

  const user = [
    `# Exploration: ${exploration.name}`,
    "",
    `## Seed idea`,
    exploration.seed,
    "",
    ancestors.length > 0 ? `## Ancestor chain (your lineage)` : "",
    ancestors.length > 0 ? ancestorChain : "",
    "",
    `## Your siblings (explore something DIFFERENT from these)`,
    siblingContext,
    "",
    `## Your direction`,
    node.planSummary
      ? `You should explore: **${node.planSummary}**`
      : "Explore a novel direction that diverges from your siblings.",
    "",
    "## Instructions",
    "Write a detailed exploration of your direction. Be substantive and specific.",
    "Your first line should be a brief, evocative title for this node (just the title text, no # prefix).",
    "Then a blank line, then the content.",
  ]
    .filter((line) => line !== undefined)
    .join("\n");

  return { system, user };
}

/**
 * Build the prompt for the branching plan phase.
 */
export function buildPlanPrompt(request: PlanRequest): {
  system: string;
  user: string;
} {
  const { parentNode, ancestors, exploration, n, detail } = request;

  const system = [
    "You are a divergent thinking engine. Your job is to propose meaningfully different directions",
    "to explore from a given idea. Each direction should be genuinely distinct — not just",
    "rephrasing the same concept.",
    "",
    "Rules:",
    "- Each direction must be substantially different from the others",
    "- Be creative but grounded — directions should be plausible extensions of the parent idea",
    "- Match the requested detail level exactly",
    request.extensionPlanPrompt || "",
  ]
    .filter(Boolean)
    .join("\n");

  const detailInstruction = getDetailInstruction(detail);

  const ancestorSummary =
    ancestors.length > 0
      ? ancestors
          .map((a) => `- ${a.title || "Root"}: ${truncate(a.content || "", 200)}`)
          .join("\n")
      : "";

  const user = [
    `# Exploration: ${exploration.name}`,
    "",
    `## Seed`,
    exploration.seed,
    "",
    ancestors.length > 0 ? "## Path so far" : "",
    ancestorSummary,
    "",
    `## Current node`,
    `**${parentNode.title || "Root"}**: ${truncate(parentNode.content || exploration.seed, 400)}`,
    "",
    `## Task`,
    `Propose exactly ${n} different directions to explore from this node.`,
    detailInstruction,
    "",
    `Output exactly ${n} lines, one direction per line. No numbering, no bullets, just the direction text.`,
  ]
    .filter((line) => line !== undefined)
    .join("\n");

  return { system, user };
}

function getDetailInstruction(detail: PlanDetail): string {
  switch (detail) {
    case "brief":
      return "Each direction should be ~5 words maximum. Just a phrase.";
    case "sentence":
      return "Each direction should be exactly 1 sentence.";
    case "detailed":
      return "Each direction should be 2-3 sentences explaining the angle.";
    case "none":
      return "";
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}

/**
 * Build the system + user prompts for synthesis pass.
 *
 * The agent receives a condensed view of the full graph and produces
 * structured JSON with a summary and typed annotations.
 */
export function buildSynthesizePrompt(request: SynthesizeRequest): {
  system: string;
  user: string;
} {
  const { exploration, nodes, crosslinks } = request;

  const activeNodes = nodes.filter((n) => n.status !== "pruned");
  const root = activeNodes.find((n) => n.parentId === null);

  const system = [
    "You are a synthesis agent. You analyze an exploration graph — a tree of ideas branching from a seed —",
    "and produce structured observations about the connections, tensions, and patterns across branches.",
    "",
    "Your job is to find what the tree itself cannot see: the hidden links between distant branches,",
    "the contradictions that reveal deeper questions, and the emergent themes that unify the whole.",
    "",
    "You output ONLY valid JSON in the exact format specified. No markdown, no commentary outside the JSON.",
    request.extensionSystemPrompt || "",
  ]
    .filter(Boolean)
    .join("\n");

  // Build a branch-organized view of the graph
  const branchSummaries = buildBranchSummaries(activeNodes, root);
  const existingCrosslinks =
    crosslinks.length > 0
      ? crosslinks
          .map(
            (cl) =>
              `- ${cl.sourceId} ↔ ${cl.targetId}${cl.label ? ` (${cl.label})` : ""}`
          )
          .join("\n")
      : "None.";

  const user = [
    `# Exploration: ${exploration.name}`,
    "",
    `## Seed idea`,
    exploration.seed,
    "",
    `## Graph structure`,
    `Branching factor: ${exploration.n} | Max depth: ${exploration.m} | Extension: ${exploration.extension}`,
    `Total active nodes: ${activeNodes.length}`,
    "",
    `## Branches`,
    branchSummaries,
    "",
    `## Existing cross-links`,
    existingCrosslinks,
    "",
    `## Your task`,
    `Analyze this exploration graph and produce a JSON response with:`,
    `1. A "summary" — a concise synthesis (2-4 paragraphs) of the exploration's key themes, patterns, and insights.`,
    `2. An "annotations" array with typed observations:`,
    "",
    `Annotation types:`,
    `- "crosslink": a connection between two nodes in different branches that share a theme, dependency, or tension.`,
    `  Requires "sourceNodeId" and "targetNodeId" (both must be valid node IDs from the graph above).`,
    `  "content" explains the relationship.`,
    `- "contradiction": a tension or incompatibility between nodes.`,
    `  Requires "sourceNodeId" and "targetNodeId". "content" explains the contradiction.`,
    `- "note": a general observation about a node or pattern.`,
    `  Requires "sourceNodeId" (the node it's about). "content" is the observation.`,
    `- "merge_suggestion": a suggestion to combine or reconcile ideas from different branches.`,
    `  Requires "sourceNodeId" and "targetNodeId". "content" explains how they could merge.`,
    "",
    `Respond with ONLY this JSON (no wrapping markdown):`,
    `{`,
    `  "summary": "...",`,
    `  "annotations": [`,
    `    { "type": "crosslink", "sourceNodeId": "...", "targetNodeId": "...", "content": "..." },`,
    `    { "type": "contradiction", "sourceNodeId": "...", "targetNodeId": "...", "content": "..." },`,
    `    { "type": "note", "sourceNodeId": "...", "content": "..." },`,
    `    { "type": "merge_suggestion", "sourceNodeId": "...", "targetNodeId": "...", "content": "..." }`,
    `  ]`,
    `}`,
    "",
    `Guidelines:`,
    `- Only reference node IDs that actually exist in the graph above`,
    `- Find non-obvious connections — the interesting ones aren't between siblings`,
    `- Be specific in your annotations — cite what each node says and why the connection matters`,
    `- Don't suggest crosslinks that already exist`,
    `- Aim for quality over quantity — 5 excellent annotations beat 20 obvious ones`,
  ].join("\n");

  return { system, user };
}

/**
 * Build a condensed, branch-organized summary of the graph.
 * Groups nodes by their depth-1 ancestor (main branch).
 */
function buildBranchSummaries(
  activeNodes: LainNode[],
  root: LainNode | undefined
): string {
  if (!root) return "Empty graph.";

  const lines: string[] = [];
  lines.push(`### Root: ${root.title ?? "Root"}`);
  lines.push(truncate(root.content ?? "", 300));
  lines.push("");

  // Get depth-1 children (main branches)
  const branches = activeNodes
    .filter((n) => n.parentId === root.id)
    .sort((a, b) => a.branchIndex - b.branchIndex);

  for (const branch of branches) {
    lines.push(`### Branch: ${branch.id} — ${branch.title ?? "Untitled"}`);
    lines.push(truncate(branch.content ?? "", 200));

    // Get all descendants of this branch
    const descendants = getDescendantsOf(branch.id, activeNodes);
    for (const desc of descendants) {
      const indent = "  ".repeat(desc.depth - branch.depth);
      lines.push(
        `${indent}[${desc.id}] ${desc.title ?? "Untitled"}: ${truncate(desc.content ?? "", 150)}`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Get all descendants of a node ID from a flat node array.
 */
function getDescendantsOf(
  nodeId: string,
  allNodes: LainNode[]
): LainNode[] {
  const result: LainNode[] = [];
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = allNodes
      .filter((n) => n.parentId === current)
      .sort((a, b) => a.branchIndex - b.branchIndex);
    for (const child of children) {
      result.push(child);
      queue.push(child.id);
    }
  }
  return result;
}

// ============================================================================
// Synthesis response parser
// ============================================================================

const VALID_ANNOTATION_TYPES = new Set<AnnotationType>([
  "crosslink",
  "contradiction",
  "note",
  "merge_suggestion",
]);

/**
 * Parse the synthesis agent's JSON response into a typed SynthesizeResponse.
 * Handles common model quirks: markdown code fences, trailing commas, etc.
 */
export function parseSynthesizeResponse(
  text: string,
  model: string,
  provider: Provider
): SynthesizeResponse {
  // Strip markdown code fences if present
  let jsonStr = text.trim();
  if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  let parsed: { summary?: string; annotations?: unknown[] };
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Try to extract JSON from surrounding text
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        // Last resort: return the text as the summary with no annotations
        return {
          summary: text,
          annotations: [],
          model,
          provider,
        };
      }
    } else {
      return {
        summary: text,
        annotations: [],
        model,
        provider,
      };
    }
  }

  const summary = typeof parsed.summary === "string" ? parsed.summary : text;

  const annotations: SynthesisAnnotationData[] = [];
  if (Array.isArray(parsed.annotations)) {
    for (const raw of parsed.annotations) {
      if (!raw || typeof raw !== "object") continue;
      const a = raw as Record<string, unknown>;

      const type = a.type as string;
      if (!VALID_ANNOTATION_TYPES.has(type as AnnotationType)) continue;

      annotations.push({
        type: type as AnnotationType,
        sourceNodeId: typeof a.sourceNodeId === "string" ? a.sourceNodeId : undefined,
        targetNodeId: typeof a.targetNodeId === "string" ? a.targetNodeId : undefined,
        content: typeof a.content === "string" ? a.content : "",
      });
    }
  }

  return { summary, annotations, model, provider };
}


