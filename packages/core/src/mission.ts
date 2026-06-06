// Mission derivation — turns a seed into an explicit intent + success criteria.
//
// This is the "validation contract" idea (à la Factory Missions) adapted to
// ideation: before generating, we make the goal unambiguous and write a finite
// checklist the whole graph should satisfy. The contract is injected into every
// node-agent and used by synthesis as a rubric.

import type { AgentProvider, Mission } from "@lain/shared";
import { nowISO } from "@lain/shared";

const SYSTEM = `You are a mission architect for an ideation engine. Given a seed idea, you define what a genuinely excellent, rigorous exploration of it must achieve.

Return ONLY minified JSON of the form:
{"intent":"<one vivid paragraph: what this exploration is really after, the deeper question beneath the seed>","criteria":["<testable success criterion>", "..."]}

Rules:
- 4 to 7 criteria. Each is a concrete, checkable property of a great resulting idea-graph (coverage, tension, originality, internal consistency, actionable depth, etc.) — not generic platitudes.
- Criteria should be specific to THIS seed.
- No prose outside the JSON.`;

/**
 * Derive an intent contract for an exploration. `refinement` lets the user
 * sharpen the intent (e.g. from an interview or a --mission flag).
 */
export async function deriveIntentContract(
  agent: AgentProvider,
  explorationId: string,
  seed: string,
  opts: { extension?: string; refinement?: string } = {}
): Promise<Mission> {
  const user = [
    `Seed: ${seed}`,
    opts.extension && opts.extension !== "freeform" ? `Lens: ${opts.extension}` : "",
    opts.refinement ? `User's refinement of intent: ${opts.refinement}` : "",
  ].filter(Boolean).join("\n");

  let intent = opts.refinement || seed;
  let criteria: string[] = [];
  try {
    const raw = await agent.generateRaw(SYSTEM, user, 800);
    const parsed = parseContract(raw);
    if (parsed.intent) intent = parsed.intent;
    if (parsed.criteria.length) criteria = parsed.criteria;
  } catch {
    // fall back to seed-as-intent with no criteria
  }

  return { explorationId, intent, criteria, createdAt: nowISO() };
}

/** Extract {intent, criteria} from a model response that should be JSON. */
export function parseContract(raw: string): { intent: string; criteria: string[] } {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) return { intent: "", criteria: [] };
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as { intent?: unknown; criteria?: unknown };
    return {
      intent: typeof obj.intent === "string" ? obj.intent.trim() : "",
      criteria: Array.isArray(obj.criteria) ? obj.criteria.map((c) => String(c).trim()).filter(Boolean) : [],
    };
  } catch {
    return { intent: "", criteria: [] };
  }
}
