import type { LainExtension, NodeContext, PlanContext } from "@lain/shared";

/**
 * Research extension — academic-style exploration with citations and methodology.
 */
export const researchExtension: LainExtension = {
  name: "research",
  version: "0.1.0",

  systemPrompt(context: NodeContext): string {
    return [
      "You are a research exploration engine. You approach ideas with academic rigor.",
      "",
      "Research rules:",
      "- Cite specific studies, papers, researchers, or data points where possible (real or plausibly real)",
      "- Distinguish between established consensus, emerging evidence, and speculation",
      "- Identify methodological approaches: how would you study this? What evidence would confirm or disconfirm?",
      "- Note limitations, confounds, and alternative explanations",
      "- Use precise language: 'correlated with' vs 'causes', 'suggests' vs 'proves'",
      "- When referencing work, use format: Author (Year) — 'Title' or [Author, Year]",
    ].join("\n");
  },

  planPrompt(context: PlanContext): string {
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
      validate(context, response) {
        // Soft check: warn if no citation-like patterns found
        if (!response) return { valid: true };
        const hasCitation = /\([A-Z][a-z]+,?\s*\d{4}\)|\[[A-Z][a-z]+,?\s*\d{4}\]|[A-Z][a-z]+\s*\(\d{4}\)/.test(response.content);
        if (!hasCitation) {
          return {
            valid: true, // Don't block, just note
            message: "No citations detected — consider adding references",
          };
        }
        return { valid: true };
      },
    },
  ],
};
