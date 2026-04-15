// @lain/shared — shared types, config, and utilities

// ============================================================================
// Node & Graph Types
// ============================================================================

export type NodeStatus = "pending" | "generating" | "complete" | "pruned";
export type Strategy = "bf" | "df";
export type PlanDetail = "brief" | "sentence" | "detailed" | "none";
export type Provider = "anthropic" | "bedrock" | "openai";

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
  provider: Provider | null;
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

export interface AgentProvider {
  generate(request: GenerateRequest): Promise<GenerateResponse>;
  generateStream(
    request: GenerateRequest,
    onChunk: (chunk: string) => void
  ): Promise<GenerateResponse>;
  plan(request: PlanRequest): Promise<PlanResponse>;
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
