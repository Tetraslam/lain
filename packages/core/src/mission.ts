// Missions — front-loaded cognition + autonomous validation, adapted from
// Factory's Missions to ideation.
//
// Three separated roles, each a fresh agent context (no self-evaluation bias):
//   • architect  — writes the validation CONTRACT first (testable assertions),
//                  THEN decomposes into features (branch angles) that each claim
//                  assertions. Contract-first so it reflects the goal, not a plan.
//   • validator  — independently audits the finished graph against the contract
//                  as a black box (reads node output, not worker reasoning).
//   • orchestrator (planFixFeatures) — turns unmet assertions into targeted fix
//                  work the workers (node-agents) then execute. Loops until the
//                  contract is satisfied or a round budget is hit.

import type {
  AgentProvider,
  Mission,
  MissionAssertion,
  MissionFeature,
  MissionReport,
  AssertionResult,
  Exploration,
} from "@lain/shared";
import { nowISO } from "@lain/shared";
import { Graph } from "./graph.js";

function extractJson(raw: string): any {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Architect: contract-first plan
// ---------------------------------------------------------------------------

const CONTRACT_SYSTEM = `You are the architect of a "mission" for an ideation engine. Before any exploration happens, you write the VALIDATION CONTRACT: a finite checklist of testable assertions that define what a complete, excellent exploration of the seed must achieve.

Return ONLY minified JSON: {"intent":"<one vivid paragraph naming the deeper question beneath the seed>","assertions":[{"id":"A1","text":"<a concrete, black-box-checkable property the finished idea-graph must satisfy>"}]}

Rules:
- 4 to 7 assertions. Each is specific to THIS seed and verifiable by reading the resulting ideas (coverage of a required dimension, a genuine tension explored, an original mechanism proposed, internal consistency, actionable depth, etc.).
- Write the contract from the GOAL, not from any plan of how to explore. No prose outside the JSON.`;

const FEATURES_SYSTEM = `You are decomposing a mission into FEATURES for an ideation engine. Each feature is one branch angle the exploration will pursue, and it claims which contract assertions it is responsible for advancing. Together the features must cover every assertion.

Return ONLY minified JSON: {"features":[{"id":"F1","angle":"<the specific angle/direction this branch explores>","assertions":["A1","A3"]}]}

Rules:
- Produce exactly N features (given below). Distinct, non-overlapping angles. Every assertion id must be claimed by at least one feature. No prose outside the JSON.`;

/** Plan a mission contract-first, then decompose into N features. */
export async function planMission(
  agent: AgentProvider,
  explorationId: string,
  seed: string,
  n: number,
  opts: { extension?: string; refinement?: string } = {}
): Promise<Mission> {
  const ctx = [
    `Seed: ${seed}`,
    opts.extension && opts.extension !== "freeform" ? `Lens: ${opts.extension}` : "",
    opts.refinement ? `User's refinement of intent: ${opts.refinement}` : "",
  ].filter(Boolean).join("\n");

  // 1) Contract first.
  let intent = opts.refinement || seed;
  let assertions: MissionAssertion[] = [];
  try {
    const obj = extractJson(await agent.generateRaw(CONTRACT_SYSTEM, ctx, 900));
    if (obj?.intent) intent = String(obj.intent).trim();
    assertions = normalizeAssertions(obj?.assertions);
  } catch { /* fall back below */ }

  // 2) Features that claim assertions.
  let features: MissionFeature[] = [];
  if (assertions.length > 0) {
    const featCtx = `${ctx}\n\nN = ${n}\nIntent: ${intent}\nAssertions:\n${assertions.map((a) => `${a.id}. ${a.text}`).join("\n")}`;
    try {
      const obj = extractJson(await agent.generateRaw(FEATURES_SYSTEM, featCtx, 900));
      features = normalizeFeatures(obj?.features, assertions);
    } catch { /* leave empty → orchestrator falls back to generic planning */ }
  }

  return { explorationId, intent, assertions, features, createdAt: nowISO() };
}

// ---------------------------------------------------------------------------
// Clarification interview — the cognitive-frontloading gate.
//
// Before any exploration runs, the architect investigates: it asks sharp
// clarifying questions until the goal is unambiguous, and only then finalizes
// the contract. Interactive surfaces refuse to proceed until this completes.
// ---------------------------------------------------------------------------

export interface InterviewTurn {
  question: string;
  answer: string;
}

export type InterviewResult =
  | { done: false; questions: string[]; rationale?: string }
  | { done: true; mission: Mission };

const INTERVIEW_SYSTEM = `You are a mission architect for an ideation engine. In THIS phase your only job is to make the goal unambiguous before any exploration begins — front-load the hard thinking.

Given the seed and any prior answers, decide ONE of:
- If scope, intent, audience, constraints, or what would make the result excellent are still genuinely unclear, ask 2–4 SHARP clarifying questions whose answers would materially change what gets explored. Never ask generic, rhetorical, or yes/no-obvious questions. Don't re-ask anything already answered.
- Only once the goal is clear, finalize the validation contract.

Return ONLY minified JSON, exactly ONE of:
  {"ready":false,"questions":["...","..."]}
  {"ready":true,"intent":"<one vivid paragraph>","assertions":[{"id":"A1","text":"<testable, black-box-checkable property>"}],"features":[{"id":"F1","angle":"<branch angle>","assertions":["A1"]}]}

When ready: 4–7 assertions written from the goal (not from any plan); produce exactly N features (given below) that each claim assertions and together cover every assertion. No prose outside the JSON.`;

/**
 * One turn of the clarification interview. Returns either more questions (the
 * goal isn't rigorous yet) or the finalized mission. After `maxRounds` it forces
 * finalization so the loop always terminates.
 */
export async function interviewMission(
  agent: AgentProvider,
  explorationId: string,
  seed: string,
  n: number,
  history: InterviewTurn[],
  opts: { extension?: string; maxRounds?: number } = {}
): Promise<InterviewResult> {
  const maxRounds = opts.maxRounds ?? 3;
  const qa = history.map((t, i) => `Q${i + 1}: ${t.question}\nA${i + 1}: ${t.answer || "(no preference)"}`).join("\n");
  const ctx = [
    `Seed: ${seed}`,
    opts.extension && opts.extension !== "freeform" ? `Lens: ${opts.extension}` : "",
    `N = ${n}`,
    qa ? `Clarifications so far:\n${qa}` : "",
    history.length >= maxRounds ? "You have asked enough — finalize the contract now." : "",
  ].filter(Boolean).join("\n");

  const refinement = history.map((t) => `${t.question} ${t.answer}`).join(" · ");

  let obj: any = null;
  try {
    obj = extractJson(await agent.generateRaw(INTERVIEW_SYSTEM, ctx, 1300));
  } catch { /* fall through to finalize */ }

  // More questions wanted (and we still have budget).
  if (obj && obj.ready === false && Array.isArray(obj.questions) && history.length < maxRounds) {
    const questions = obj.questions.map((q: unknown) => String(q).trim()).filter(Boolean).slice(0, 4);
    if (questions.length > 0) return { done: false, questions, rationale: obj.rationale ? String(obj.rationale) : undefined };
  }

  // Finalize: prefer the contract the interviewer just produced; else fall back.
  const assertions = normalizeAssertions(obj?.assertions);
  if (assertions.length > 0) {
    return {
      done: true,
      mission: {
        explorationId,
        intent: typeof obj?.intent === "string" && obj.intent.trim() ? obj.intent.trim() : refinement || seed,
        assertions,
        features: normalizeFeatures(obj?.features, assertions),
        createdAt: nowISO(),
      },
    };
  }
  return { done: true, mission: await planMission(agent, explorationId, seed, n, { extension: opts.extension, refinement }) };
}

function normalizeAssertions(raw: unknown): MissionAssertion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a, i) => {
      if (typeof a === "string") return { id: `A${i + 1}`, text: a.trim() };
      const o = a as Record<string, unknown>;
      return { id: String(o.id ?? `A${i + 1}`).trim(), text: String(o.text ?? "").trim() };
    })
    .filter((a) => a.text);
}

function normalizeFeatures(raw: unknown, assertions: MissionAssertion[]): MissionFeature[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set(assertions.map((a) => a.id));
  return raw
    .map((f, i) => {
      const o = f as Record<string, unknown>;
      return {
        id: String(o.id ?? `F${i + 1}`).trim(),
        angle: String(o.angle ?? o.text ?? "").trim(),
        assertions: Array.isArray(o.assertions) ? o.assertions.map(String).filter((x) => ids.has(x)) : [],
      };
    })
    .filter((f) => f.angle);
}

// ---------------------------------------------------------------------------
// Validator: independent audit against the contract
// ---------------------------------------------------------------------------

const VALIDATOR_SYSTEM = `You are an independent validator for an ideation mission. You did NOT write these ideas. Audit the idea-graph against the validation contract as a black box: judge each assertion only by what the nodes actually contain.

Return ONLY minified JSON: {"results":[{"id":"A1","status":"met|partial|unmet","evidence":"<one line citing node ids>"}],"summary":"<one line: the single most important remaining gap, or 'complete'>"}

Be skeptical and concrete. "met" requires real evidence in the nodes; "partial" means touched but shallow/incomplete; "unmet" means absent.`;

/** Build a compact black-box view of the graph for the validator. */
function graphOutline(graph: Graph, exploration: Exploration): string {
  const nodes = graph.getAllNodes(exploration.id).filter((n) => n.status === "complete");
  return nodes
    .map((n) => {
      const body = (n.content || "").replace(/\s+/g, " ").slice(0, 240);
      return `${n.id} — ${n.title || "(untitled)"}: ${body}`;
    })
    .join("\n");
}

/** Independently validate the current graph against the mission contract. */
export async function validateMission(
  agent: AgentProvider,
  graph: Graph,
  exploration: Exploration,
  mission: Mission,
  round: number
): Promise<MissionReport> {
  const user = `Intent: ${mission.intent}

Contract:
${mission.assertions.map((a) => `${a.id}. ${a.text}`).join("\n")}

Idea-graph (${exploration.name}):
${graphOutline(graph, exploration)}`;

  let results: AssertionResult[] = mission.assertions.map((a) => ({ id: a.id, status: "unmet" as const, evidence: "" }));
  let summary = "";
  try {
    const obj = extractJson(await agent.generateRaw(VALIDATOR_SYSTEM, user, 1200));
    if (obj?.results && Array.isArray(obj.results)) {
      const byId = new Map<string, AssertionResult>();
      for (const r of obj.results as Record<string, unknown>[]) {
        const id = String(r.id ?? "").trim();
        const status = (["met", "partial", "unmet"].includes(String(r.status)) ? r.status : "unmet") as AssertionResult["status"];
        if (id) byId.set(id, { id, status, evidence: String(r.evidence ?? "").trim() });
      }
      // Keep contract order; fill any missing as unmet.
      results = mission.assertions.map((a) => byId.get(a.id) ?? { id: a.id, status: "unmet", evidence: "" });
    }
    if (obj?.summary) summary = String(obj.summary).trim();
  } catch { /* default all-unmet */ }

  const satisfied = results.every((r) => r.status === "met");
  return { explorationId: exploration.id, round, satisfied, results, summary, createdAt: nowISO() };
}

// ---------------------------------------------------------------------------
// Orchestrator: turn unmet assertions into targeted fix features
// ---------------------------------------------------------------------------

const FIX_SYSTEM = `You are the orchestrator of an ideation mission steering it to completion. Given the unmet/partial assertions and the current idea-graph, propose targeted fix work: each fix is ONE new branch that closes a specific gap.

Return ONLY minified JSON: {"fixes":[{"parent":"<existing node id, or 'root'>","angle":"<the specific direction that will satisfy the gap>","assertions":["A2"]}]}

Rules:
- At most ${"${MAX}"} fixes — only the highest-leverage ones.
- Attach each fix under a TOP-LEVEL branch (a direct child of root, e.g. "root-2") or under "root" itself — a mission closes gaps by BROADENING coverage, not by burrowing deeper. Do NOT attach under deep leaf nodes; the exploration depth is capped at ${"${DEPTH}"} and fixes that would exceed it are reparented upward automatically.
- No prose outside the JSON.`;

export interface FixFeature {
  parent: string;
  angle: string;
  assertions: string[];
}

/** Plan targeted fix features for the assertions that aren't yet met. */
export async function planFixFeatures(
  agent: AgentProvider,
  graph: Graph,
  exploration: Exploration,
  mission: Mission,
  report: MissionReport,
  maxFixes: number
): Promise<FixFeature[]> {
  const gaps = report.results.filter((r) => r.status !== "met");
  if (gaps.length === 0) return [];
  const gapText = gaps
    .map((g) => {
      const a = mission.assertions.find((x) => x.id === g.id);
      return `${g.id} (${g.status}): ${a?.text ?? ""} — ${g.evidence}`;
    })
    .join("\n");
  const user = `Intent: ${mission.intent}

Unmet/partial assertions:
${gapText}

Current idea-graph:
${graphOutline(graph, exploration)}`;

  const validIds = new Set(graph.getAllNodes(exploration.id).map((n) => n.id));
  const fixSystem = FIX_SYSTEM.replace("${MAX}", String(maxFixes)).replace("${DEPTH}", String(exploration.m));
  try {
    const obj = extractJson(await agent.generateRaw(fixSystem, user, 900));
    if (!obj?.fixes || !Array.isArray(obj.fixes)) return [];
    return (obj.fixes as Record<string, unknown>[])
      .map((f) => ({
        parent: validIds.has(String(f.parent)) ? String(f.parent) : "root",
        angle: String(f.angle ?? "").trim(),
        assertions: Array.isArray(f.assertions) ? f.assertions.map(String) : [],
      }))
      .filter((f) => f.angle)
      .slice(0, maxFixes);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Back-compat shim (older call sites) — a mission with no decomposition.
// ---------------------------------------------------------------------------

/** @deprecated use planMission. Kept so older imports keep compiling. */
export async function deriveIntentContract(
  agent: AgentProvider,
  explorationId: string,
  seed: string,
  opts: { extension?: string; refinement?: string } = {}
): Promise<Mission> {
  return planMission(agent, explorationId, seed, 3, opts);
}

export function parseContract(raw: string): { intent: string; criteria: string[] } {
  const obj = extractJson(raw);
  return {
    intent: typeof obj?.intent === "string" ? obj.intent.trim() : "",
    criteria: normalizeAssertions(obj?.assertions).map((a) => a.text),
  };
}
