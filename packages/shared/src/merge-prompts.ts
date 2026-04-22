/**
 * Merge preview generation prompts — pure functions for building and parsing
 * merge resolution/synthesis prompts. Lives in shared so core doesn't need
 * to depend on agents.
 */
import type { LainNode } from "./index.js";

export interface MergeGenerationRequest {
  type: "contradiction" | "merge_suggestion";
  sourceNode: LainNode;
  targetNode: LainNode;
  annotationContent: string;
  explorationSeed: string;
}

/**
 * Build prompts for generating a resolution (contradiction) or synthesis (merge_suggestion) node.
 */
export function buildMergeGenerationPrompt(request: MergeGenerationRequest): {
  system: string;
  user: string;
} {
  const { type, sourceNode, targetNode, annotationContent, explorationSeed } = request;

  const system = type === "contradiction"
    ? [
        "You are a resolution agent. Given two nodes in an exploration that contradict each other,",
        "you produce a new piece of writing that reconciles, resolves, or productively synthesizes the tension.",
        "You don't pick a side — you find the deeper truth that accounts for both positions.",
        "",
        "Output ONLY valid JSON: { \"title\": \"...\", \"content\": \"...\" }",
        "The title should be concise (3-8 words). The content should be 2-4 paragraphs.",
      ].join("\n")
    : [
        "You are a synthesis agent. Given two nodes in an exploration that could be merged or combined,",
        "you produce a new piece of writing that unifies their ideas into something stronger than either alone.",
        "Draw from both sources, finding the emergent insight that neither contains individually.",
        "",
        "Output ONLY valid JSON: { \"title\": \"...\", \"content\": \"...\" }",
        "The title should be concise (3-8 words). The content should be 2-4 paragraphs.",
      ].join("\n");

  const user = [
    `Exploration seed: "${explorationSeed}"`,
    "",
    `## Source node: "${sourceNode.title || sourceNode.id}"`,
    sourceNode.content || "(no content)",
    "",
    `## Target node: "${targetNode.title || targetNode.id}"`,
    targetNode.content || "(no content)",
    "",
    `## ${type === "contradiction" ? "The contradiction" : "Why these should merge"}`,
    annotationContent,
    "",
    `## Your task`,
    type === "contradiction"
      ? "Write a resolution that reconciles these two perspectives. Find what's true in both and produce something that accounts for the full picture."
      : "Synthesize these two branches into a unified piece that's stronger than either alone. Find the emergent insight.",
    "",
    "Respond with ONLY JSON: { \"title\": \"...\", \"content\": \"...\" }",
  ].join("\n");

  return { system, user };
}

/**
 * Parse the merge generation response.
 */
export function parseMergeGenerationResponse(text: string): { title: string; content: string } {
  let jsonStr = text.trim();
  if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  try {
    const parsed = JSON.parse(jsonStr);
    return {
      title: typeof parsed.title === "string" ? parsed.title : "Untitled",
      content: typeof parsed.content === "string" ? parsed.content : text,
    };
  } catch {
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          title: typeof parsed.title === "string" ? parsed.title : "Untitled",
          content: typeof parsed.content === "string" ? parsed.content : text,
        };
      } catch { /* fall through */ }
    }
    return { title: "Resolution", content: text };
  }
}
