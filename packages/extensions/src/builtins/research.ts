import type { LainExtension, NodeContext, PlanContext } from "@lain/shared";

/**
 * Research extension — literature-review-grade exploration grounded in real,
 * cited web sources. Expects a web-search tool (e.g. firecrawl via MCP); its
 * node-agents are given a `cite` tool and are told to verify before they assert.
 */
export const researchExtension: LainExtension = {
  name: "research",
  version: "0.2.0",

  // This lens lives or dies on real sources — surfaces warn at creation if no
  // web-search tool is active, and the `cite`/`list_citations` tools turn on.
  requiresWebSearch: true,

  systemPrompt(_context: NodeContext): string {
    return [
      "You are a research exploration engine. You approach ideas with the rigor of a literature review: claims are grounded in real, retrievable sources, and uncertainty is stated plainly.",
      "",
      "Grounding & citations:",
      "- Use your web-search/scrape tools to find primary sources for the non-obvious factual claims you make.",
      "- When a source backs a claim, call `cite` with its URL (and title) to get a marker like [3], then place [3] inline right after that claim. Reuse a source's marker rather than re-citing it.",
      "- Cite only sources you actually retrieved. NEVER invent citations, URLs, authors, dates, or quotes. If you cannot find a source for a claim, either drop the claim or explicitly mark it as your own inference/speculation.",
      "",
      "Verify, don't assume:",
      "- If the material references a model, product, person, paper, company, or event you don't recognize, treat that as a gap in YOUR knowledge (it may post-date your training), not an error in the prompt. Search to find out what it actually is before describing it.",
      "- Never silently substitute a similar thing you do know (e.g. an older model with a similar name), and never quietly recast a real subject as hypothetical. If after searching you still can't confirm it, say so.",
      "",
      "Method:",
      "- Distinguish established consensus, emerging evidence, and speculation, and keep claims consistent with what you cited.",
      "- Note methodology, limitations, confounds, and alternative explanations where they matter.",
      "- Use precise language: 'correlated with' vs 'causes', 'suggests' vs 'proves'.",
    ].join("\n");
  },

  planPrompt(_context: PlanContext): string {
    return [
      "For a research exploration, each direction should represent a distinct research angle:",
      "- Different disciplines or methodologies that could study this question",
      "- Different scales of analysis (individual, group, institutional, systemic)",
      "- Different theoretical frameworks that would interpret the phenomenon differently",
      "- Empirical vs theoretical vs applied/practical angles",
      "",
      "Each direction should be a specific research question or hypothesis, not a vague topic.",
    ].join("\n");
  },

  validators: [
    {
      name: "citation-check",
      phase: "after:generate",
      validate(_context, response) {
        // Soft nudge: note if a research node made claims without any inline
        // citation markers (the agent registers sources via the `cite` tool).
        if (!response) return { valid: true };
        const hasCitation = /\[\d+\]/.test(response.content);
        if (!hasCitation) {
          return { valid: true, message: "No inline citations ([n]) — ground claims in real sources via `cite`" };
        }
        return { valid: true };
      },
    },
  ],
};
