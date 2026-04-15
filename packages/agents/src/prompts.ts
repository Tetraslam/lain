import type {
  GenerateRequest,
  PlanRequest,
  LainNode,
  PlanDetail,
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
