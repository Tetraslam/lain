import type { LainExtension, NodeContext, PlanContext } from "@lain/shared";

/**
 * Debate extension — adversarial branching with pro/con/steelman/critique.
 */
export const debateExtension: LainExtension = {
  name: "debate",
  version: "0.1.0",

  systemPrompt(context: NodeContext): string {
    const depth = context.depth;

    if (depth <= 1) {
      return [
        "You are a rigorous debate engine. You explore ideas through structured argumentation.",
        "",
        "At this depth, take a clear POSITION on the topic. Be bold and committed.",
        "Don't hedge or present 'both sides' — argue forcefully for your assigned direction.",
        "Use evidence, logic, historical examples, and thought experiments.",
        "Acknowledge the strongest version of opposing arguments only to dismantle them.",
      ].join("\n");
    }

    return [
      "You are a rigorous debate engine continuing a chain of argumentation.",
      "",
      "At this depth, you should:",
      "- If your parent argued FOR something, either STEELMAN it (make it stronger) or present the strongest COUNTER-ARGUMENT",
      "- If your parent argued AGAINST something, either DEFEND the original position or find a NOVEL ANGLE that reframes the debate",
      "- Always engage directly with the specific claims made by your ancestors — don't argue past them",
      "- Introduce new evidence, examples, or frameworks that haven't appeared in the chain yet",
    ].join("\n");
  },

  planPrompt(context: PlanContext): string {
    return [
      "For a debate exploration, each direction should represent a distinct argumentative move:",
      "- A strong argument FOR the proposition",
      "- A strong argument AGAINST the proposition",
      "- A steelman (the strongest possible version of the weakest position)",
      "- A novel reframing (change the terms of the debate entirely)",
      "- A critique of the underlying assumptions",
      "",
      "Each direction should be an actual argumentative claim, not a meta-description.",
      "Bad: 'An argument against the proposition'",
      "Good: 'The efficiency gains are illusory because they externalize costs onto future generations'",
    ].join("\n");
  },
};
