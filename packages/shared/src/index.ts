// @lain/shared — shared types, config, and utilities

// Re-export config module
export {
  loadConfig,
  loadCredentials,
  saveConfig,
  saveCredentials,
  saveWorkspaceConfig,
  configExists,
  slugify,
  deepMerge,
  type Credentials,
} from "./config.js";

// Re-export merge prompt utilities
export {
  buildMergeGenerationPrompt,
  parseMergeGenerationResponse,
  type MergeGenerationRequest,
} from "./merge-prompts.js";

// ============================================================================
// Node & Graph Types
// ============================================================================

export type NodeStatus = "pending" | "generating" | "complete" | "pruned";
export type Strategy = "bf" | "df";
export type PlanDetail = "brief" | "sentence" | "detailed" | "none";
export type Provider = "anthropic" | "bedrock" | "openai";

/** Internal-only provider marker for synthesis-generated nodes. Not a real provider. */
export type NodeProvider = Provider | "synthesis" | "manual";

export interface LainNode {
  id: string;
  explorationId: string;
  parentId: string | null;
  content: string | null;
  contentConflict: string | null;
  title: string | null;
  depth: number;
  branchIndex: number;
  status: NodeStatus;
  model: string | null;
  provider: NodeProvider | null;
  planSummary: string | null;
  extensionData: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface Exploration {
  id: string;
  name: string;
  seed: string;
  n: number;
  m: number;
  strategy: Strategy;
  planDetail: PlanDetail;
  extension: string;
  createdAt: string;
  updatedAt: string;
}

export interface Crosslink {
  sourceId: string;
  targetId: string;
  label: string | null;
  aiSuggested: boolean;
  createdAt: string;
}

export interface Synthesis {
  id: string;
  explorationId: string;
  content: string;
  model: string | null;
  status: "pending" | "complete";
  merged: boolean;
  createdAt: string;
}

export type AnnotationType =
  | "crosslink"
  | "contradiction"
  | "note"
  | "merge_suggestion";

export interface SynthesisAnnotation {
  id: string;
  synthesisId: string;
  type: AnnotationType;
  sourceNodeId: string | null;
  targetNodeId: string | null;
  content: string | null;
  merged: boolean;
  createdAt: string;
}

/** A persistent note attached to a node (produced by merging a 'note' annotation). */
export interface NodeAnnotation {
  id: string;
  nodeId: string;
  content: string;
  source: "synthesis" | "user"; // who created it
  synthesisAnnotationId: string | null; // link back to the synthesis annotation that produced this
  createdAt: string;
}

/** Result of generating content for a contradiction resolution or merge synthesis. */
export interface MergePreview {
  title: string;
  content: string;
  parentId: string; // where the new node would be placed
  crosslinkTo: string[]; // nodes the new node would be crosslinked to
}

/** A diff describing what a merge operation will do to the graph. */
export interface SynthesisDiff {
  annotationId: string;
  annotationType: AnnotationType;
  /** What changes this merge will produce. */
  changes: SynthesisDiffChange[];
}

export type SynthesisDiffChange =
  | { type: "add_crosslink"; sourceId: string; sourceTitle: string; targetId: string; targetTitle: string; label: string | null }
  | { type: "add_note"; nodeId: string; nodeTitle: string; content: string }
  | { type: "add_node"; title: string; content: string; parentId: string; parentTitle: string; crosslinkTo: { id: string; title: string }[] };

export interface SyncState {
  nodeId: string;
  filePath: string;
  contentHash: string;
  frontmatterHash: string;
  dbContentHash: string;
  dbFrontmatterHash: string;
  syncedAt: string;
}

// ============================================================================
// Config Types
// ============================================================================

export interface ProviderConfig {
  provider: Provider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  region?: string; // for bedrock
}

export interface WatchConfig {
  debounceMs: number;
  onDelete: "prune" | "ignore";
}

export interface SynthesisConfig {
  autoMerge: boolean;
}

export interface LainConfig {
  defaultModel: string;
  defaultProvider: Provider;
  providers: Record<string, ProviderConfig>;
  defaultN: number;
  defaultM: number;
  defaultStrategy: Strategy;
  defaultPlanDetail: PlanDetail;
  defaultExtension: string;
  watch: WatchConfig;
  synthesis: SynthesisConfig;
}

export const DEFAULT_CONFIG: LainConfig = {
  defaultModel: "claude-sonnet-4-6",
  defaultProvider: "anthropic",
  providers: {},
  defaultN: 3,
  defaultM: 3,
  defaultStrategy: "bf",
  defaultPlanDetail: "sentence",
  defaultExtension: "freeform",
  watch: {
    debounceMs: 500,
    onDelete: "prune",
  },
  synthesis: {
    autoMerge: false,
  },
};

// ============================================================================
// Event Types (for UI consumption)
// ============================================================================

export type LainEventType =
  | "node:created"
  | "node:generating"
  | "node:complete"
  | "node:pruned"
  | "node:content-chunk"  // streaming content
  | "exploration:created"
  | "exploration:complete"
  | "synthesis:started"
  | "synthesis:complete"
  | "sync:started"
  | "sync:file-changed"
  | "sync:conflict"
  | "sync:complete"
  | "plan:created"
  | "plan:complete"
  | "error";

export interface LainEvent {
  type: LainEventType;
  explorationId?: string;
  nodeId?: string;
  data?: unknown;
  timestamp: string;
}

export type LainEventHandler = (event: LainEvent) => void;

// ============================================================================
// Agent Types
// ============================================================================

export interface GenerateRequest {
  node: LainNode;
  ancestors: LainNode[];
  siblings: LainNode[];
  exploration: Exploration;
  extensionSystemPrompt?: string;
}

export interface GenerateResponse {
  title: string;
  content: string;
  model: string;
  provider: Provider;
}

export interface PlanRequest {
  parentNode: LainNode;
  ancestors: LainNode[];
  exploration: Exploration;
  n: number;
  detail: PlanDetail;
  extensionPlanPrompt?: string;
}

export interface PlanResponse {
  directions: string[];
}

export interface SynthesizeRequest {
  exploration: Exploration;
  nodes: LainNode[];
  crosslinks: Crosslink[];
  extensionSystemPrompt?: string;
}

/** A single annotation produced by the synthesis agent. */
export interface SynthesisAnnotationData {
  type: AnnotationType;
  sourceNodeId?: string;
  targetNodeId?: string;
  content: string;
}

export interface SynthesizeResponse {
  summary: string;
  annotations: SynthesisAnnotationData[];
  model: string;
  provider: Provider;
}

export interface AgentProvider {
  generate(request: GenerateRequest): Promise<GenerateResponse>;
  generateStream(
    request: GenerateRequest,
    onChunk: (chunk: string) => void
  ): Promise<GenerateResponse>;
  plan(request: PlanRequest): Promise<PlanResponse>;
  synthesize(request: SynthesizeRequest): Promise<SynthesizeResponse>;
  /** Raw converse: send system + user prompt, get back raw text. No prompt wrapping. */
  generateRaw(system: string, user: string, maxTokens?: number): Promise<string>;
}

// ============================================================================
// Extension Types
// ============================================================================

/** Context passed to extension hooks during node generation. */
export interface NodeContext {
  node: LainNode;
  ancestors: LainNode[];
  siblings: LainNode[];
  exploration: Exploration;
  depth: number;
}

/** Context passed to extension hooks during plan phase. */
export interface PlanContext {
  parentNode: LainNode;
  ancestors: LainNode[];
  exploration: Exploration;
  n: number;
  detail: PlanDetail;
}

/** Lifecycle hook signatures. */
export interface LifecycleHooks {
  "before:plan": (context: PlanContext) => Promise<void> | void;
  "after:plan": (context: PlanContext, directions: string[]) => Promise<string[]> | string[];
  "before:generate": (context: NodeContext) => Promise<void> | void;
  "after:generate": (context: NodeContext, response: GenerateResponse) => Promise<GenerateResponse> | GenerateResponse;
  "before:prune": (nodeId: string) => Promise<void> | void;
  "after:prune": (nodeId: string) => Promise<void> | void;
  "before:link": (sourceId: string, targetId: string) => Promise<void> | void;
  "after:link": (sourceId: string, targetId: string) => Promise<void> | void;
  "before:export": (explorationId: string) => Promise<void> | void;
  "after:export": (explorationId: string, outputDir: string) => Promise<void> | void;
  "before:sync": (explorationId: string) => Promise<void> | void;
  "after:sync": (explorationId: string) => Promise<void> | void;
  "on:error": (error: Error, context?: { nodeId?: string; explorationId?: string }) => Promise<void> | void;
}

/** Custom CLI operation registered by an extension. */
export interface OperationDefinition {
  name: string;
  description: string;
  args?: { name: string; description: string; required?: boolean }[];
  flags?: { name: string; description: string; type: "string" | "boolean" | "number" }[];
  run: (args: { positional: string[]; flags: Record<string, string | boolean> }, context: ExtensionOperationContext) => Promise<void>;
}

/** Context provided to custom extension operations. */
export interface ExtensionOperationContext {
  storage: unknown; // Storage instance — typed as unknown to avoid circular dep, cast in extensions package
  graph: unknown;   // Graph instance
  agent: AgentProvider;
  config: LainConfig;
}

/** Config field definition for extension-specific settings. */
export interface ConfigFieldDefinition {
  key: string;
  type: "string" | "number" | "boolean" | "select";
  description: string;
  default?: unknown;
  options?: { value: string; label: string }[]; // for select type
}

/** Custom node type with additional required/optional fields. */
export interface NodeTypeDefinition {
  name: string;
  fields: {
    key: string;
    type: "string" | "number" | "boolean";
    required?: boolean;
    description: string;
  }[];
}

/** Validator that runs before/after generation. */
export interface ValidatorDefinition {
  name: string;
  phase: "before:generate" | "after:generate";
  validate: (context: NodeContext, response?: GenerateResponse) => { valid: boolean; message?: string };
}

/** The full extension interface. */
export interface LainExtension {
  name: string;
  version: string;

  /** Credentials this extension needs (user provides via `lain extensions auth`). */
  requiredAuth?: { key: string; description: string; required: boolean }[];

  /** Extension-specific config schema. */
  configSchema?: ConfigFieldDefinition[];

  /** System prompt fragment injected for every node. */
  systemPrompt?: (context: NodeContext) => string;

  /** Prompt fragment injected during plan phase. */
  planPrompt?: (context: PlanContext) => string;

  /** Lifecycle hooks. */
  hooks?: Partial<LifecycleHooks>;

  /** Custom node types with additional fields. */
  nodeTypes?: NodeTypeDefinition[];

  /** Custom CLI operations (become subcommands). */
  operations?: OperationDefinition[];

  /** Custom obsidian renderer for this extension's nodes. */
  renderer?: (node: LainNode) => string | undefined;

  /** Validators that run before/after generation. */
  validators?: ValidatorDefinition[];
}

// ============================================================================
// Utilities
// ============================================================================

export function generateId(): string {
  return crypto.randomUUID().slice(0, 8);
}

export function nowISO(): string {
  return new Date().toISOString();
}

/**
 * Build a deterministic node id from its position in the tree.
 * Root node is "root", first child is "root-1", grandchild is "root-1-2", etc.
 */
export function buildNodeId(
  parentId: string | null,
  branchIndex: number
): string {
  if (parentId === null) return "root";
  return `${parentId}-${branchIndex}`;
}

// ============================================================================
// Cost Estimation
// ============================================================================

/** Per-million-token pricing. */
interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  // Sonnet 4.6
  "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
  "us.anthropic.claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
  "anthropic.claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
  // Opus 4.6
  "claude-opus-4-6": { inputPerMillion: 15, outputPerMillion: 75 },
  "us.anthropic.claude-opus-4-6-v1": { inputPerMillion: 15, outputPerMillion: 75 },
  // Sonnet 4
  "claude-sonnet-4-20250514": { inputPerMillion: 3, outputPerMillion: 15 },
  // Haiku 4
  "claude-haiku-4-20250414": { inputPerMillion: 0.8, outputPerMillion: 4 },
  // 3.5 Sonnet
  "claude-3-5-sonnet-20241022": { inputPerMillion: 3, outputPerMillion: 15 },
  // 3.5 Haiku
  "claude-3-5-haiku-20241022": { inputPerMillion: 0.8, outputPerMillion: 4 },
};

export interface CostEstimate {
  totalNodes: number;
  planCalls: number;
  generateCalls: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
  model: string;
}

/**
 * Estimate the cost of an exploration before running it.
 * Uses rough averages: ~1500 input tokens per call, ~800 output tokens per generation,
 * ~300 output tokens per plan call.
 */
export function estimateCost(
  n: number,
  m: number,
  model: string,
  planDetail: PlanDetail
): CostEstimate {
  // Count nodes at each depth
  let totalNodes = 0;
  for (let d = 1; d <= m; d++) {
    totalNodes += Math.pow(n, d);
  }

  // Plan calls: one per parent that gets expanded.
  // Parents = 1 (root) + n + n^2 + ... + n^(m-1) = (n^m - 1) / (n - 1) for n>1, else m
  let planParents: number;
  if (n <= 1) {
    planParents = m;
  } else {
    planParents = (Math.pow(n, m) - 1) / (n - 1);
  }
  const planCalls = planDetail === "none" ? 0 : planParents;
  const generateCalls = totalNodes;

  // Token estimates (rough averages based on typical prompts)
  const avgInputPerPlan = 1200;
  const avgOutputPerPlan = planDetail === "brief" ? 100 : planDetail === "sentence" ? 200 : 400;
  const avgInputPerGenerate = 1500; // ancestor chain + sibling context + system prompt
  const avgOutputPerGenerate = 800; // ~400-500 words of content

  const estimatedInputTokens =
    planCalls * avgInputPerPlan + generateCalls * avgInputPerGenerate;
  const estimatedOutputTokens =
    planCalls * avgOutputPerPlan + generateCalls * avgOutputPerGenerate;

  // Look up pricing
  const pricing = MODEL_PRICING[model] ?? { inputPerMillion: 3, outputPerMillion: 15 };
  const estimatedCostUsd =
    (estimatedInputTokens / 1_000_000) * pricing.inputPerMillion +
    (estimatedOutputTokens / 1_000_000) * pricing.outputPerMillion;

  return {
    totalNodes,
    planCalls,
    generateCalls,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedCostUsd,
    model,
  };
}
