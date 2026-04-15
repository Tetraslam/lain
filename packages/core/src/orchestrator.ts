import { Graph } from "./graph.js";
import { Storage } from "./storage.js";
import type {
  AgentProvider,
  Exploration,
  LainEvent,
  LainEventHandler,
  LainNode,
  LainExtension,
  NodeContext,
  PlanContext,
  GenerateResponse,
  Strategy,
} from "@lain/shared";
import { nowISO } from "@lain/shared";

/** Minimal extension registry interface to avoid circular dep on @lain/extensions. */
export interface ExtensionRegistryLike {
  getSystemPrompt(context: NodeContext, activeExtensions?: string[]): string;
  getPlanPrompt(context: PlanContext, activeExtensions?: string[]): string;
  runHook(hook: string, ...args: unknown[]): Promise<void>;
  runAfterPlan(context: PlanContext, directions: string[], activeExtensions?: string[]): Promise<string[]>;
  runAfterGenerate(context: NodeContext, response: GenerateResponse, activeExtensions?: string[]): Promise<GenerateResponse>;
  runValidators(phase: "before:generate" | "after:generate", context: NodeContext, response?: GenerateResponse, activeExtensions?: string[]): { valid: boolean; errors: string[] };
}

export interface OrchestratorOptions {
  dbPath: string;
  agent: AgentProvider;
  concurrency?: number;
  extensions?: ExtensionRegistryLike;
  onEvent?: LainEventHandler;
}

/**
 * Manages the expansion loop: creates pending nodes, generates content via agents,
 * respects BF/DF strategy, supports concurrent generation and extensions.
 */
export class Orchestrator {
  private storage: Storage;
  private graph: Graph;
  private agent: AgentProvider;
  private concurrency: number;
  private extensions: ExtensionRegistryLike | null;
  private onEvent: LainEventHandler;

  constructor(options: OrchestratorOptions) {
    this.storage = new Storage(options.dbPath);
    this.graph = new Graph(this.storage);
    this.agent = options.agent;
    this.concurrency = options.concurrency ?? 5;
    this.extensions = options.extensions ?? null;
    this.onEvent = options.onEvent ?? (() => {});
  }

  close(): void {
    this.storage.close();
  }

  getGraph(): Graph {
    return this.graph;
  }

  getStorage(): Storage {
    return this.storage;
  }

  /**
   * Create a new exploration and generate the full tree.
   */
  async explore(params: {
    id: string;
    name: string;
    seed: string;
    n: number;
    m: number;
    strategy: Strategy;
    planDetail: Exploration["planDetail"];
    extension: string;
  }): Promise<Exploration> {
    const exploration = this.graph.createExploration(params);

    this.emit({
      type: "exploration:created",
      explorationId: exploration.id,
    });

    if (exploration.strategy === "df") {
      await this.expandTreeDF(exploration);
    } else {
      await this.expandTreeBF(exploration);
    }

    this.emit({
      type: "exploration:complete",
      explorationId: exploration.id,
    });

    return exploration;
  }

  /**
   * Expand a single node with n new children (concurrently).
   */
  async extendNode(
    explorationId: string,
    nodeId: string,
    n: number
  ): Promise<LainNode[]> {
    const exploration = this.graph.getExploration(explorationId);
    if (!exploration) throw new Error(`Exploration not found: ${explorationId}`);

    const parentNode = this.graph.getNode(nodeId);
    if (!parentNode) throw new Error(`Node not found: ${nodeId}`);

    // Plan phase
    const planSummaries = await this.planBranches(
      parentNode,
      exploration,
      n
    );

    // Create pending children
    const children = this.graph.createChildNodes(
      explorationId,
      nodeId,
      n,
      planSummaries
    );

    // Generate children concurrently
    await this.generateNodesBatch(children, exploration);

    return children.map((c) => this.graph.getNode(c.id)!);
  }

  /**
   * Regenerate a node — reset it and run the agent again.
   * Keeps the same ID, position, and plan summary. Gets new content.
   */
  async redirectNode(
    explorationId: string,
    nodeId: string
  ): Promise<LainNode> {
    const exploration = this.graph.getExploration(explorationId);
    if (!exploration) throw new Error(`Exploration not found: ${explorationId}`);

    const node = this.graph.getNode(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    if (node.id === "root") throw new Error("Cannot redirect the root node.");

    // Reset to pending then regenerate
    this.storage.updateNodeStatus(nodeId, "pending");
    const freshNode = this.graph.getNode(nodeId)!;
    await this.generateNode(freshNode, exploration);

    return this.graph.getNode(nodeId)!;
  }

  // ========================================================================
  // Breadth-First expansion
  // ========================================================================

  private async expandTreeBF(exploration: Exploration): Promise<void> {
    for (let depth = 0; depth < exploration.m; depth++) {
      const nodesAtDepth =
        depth === 0
          ? [this.graph.getNode("root")!]
          : this.graph.getNodesAtDepth(exploration.id, depth);

      const activeNodes = nodesAtDepth.filter(
        (n) => n.status === "complete"
      );

      // Plan all parents at this depth concurrently
      const planResults = await this.runConcurrent(
        activeNodes,
        async (node) => {
          const summaries = await this.planBranches(
            node,
            exploration,
            exploration.n
          );
          return { node, summaries };
        },
        this.concurrency
      );

      // Create all pending children
      const allChildren: LainNode[] = [];
      for (const { node, summaries } of planResults) {
        const children = this.graph.createChildNodes(
          exploration.id,
          node.id,
          exploration.n,
          summaries
        );
        allChildren.push(...children);
      }

      // Generate all children at this depth concurrently
      await this.generateNodesBatch(allChildren, exploration);
    }
  }

  // ========================================================================
  // Depth-First expansion
  // ========================================================================

  private async expandTreeDF(exploration: Exploration): Promise<void> {
    // DF: for each child of root, go as deep as possible before moving to siblings
    // At each node, plan + create children, generate first child, recurse into it,
    // then generate remaining siblings concurrently

    const root = this.graph.getNode("root")!;
    await this.expandNodeDF(root, exploration, 0);
  }

  private async expandNodeDF(
    node: LainNode,
    exploration: Exploration,
    currentDepth: number
  ): Promise<void> {
    if (currentDepth >= exploration.m) return;

    // Plan phase
    const planSummaries = await this.planBranches(
      node,
      exploration,
      exploration.n
    );

    // Create pending children
    const children = this.graph.createChildNodes(
      exploration.id,
      node.id,
      exploration.n,
      planSummaries
    );

    // Generate first child and recurse deep
    if (children.length > 0) {
      await this.generateNode(children[0], exploration);
      await this.expandNodeDF(
        this.graph.getNode(children[0].id)!,
        exploration,
        currentDepth + 1
      );
    }

    // Generate remaining siblings concurrently
    if (children.length > 1) {
      const remaining = children.slice(1);
      await this.generateNodesBatch(remaining, exploration);

      // Recurse into remaining siblings concurrently
      // (each sibling's subtree is independent)
      await this.runConcurrent(
        remaining,
        async (child) => {
          const updated = this.graph.getNode(child.id)!;
          await this.expandNodeDF(updated, exploration, currentDepth + 1);
        },
        this.concurrency
      );
    }
  }

  // ========================================================================
  // Planning
  // ========================================================================

  private async planBranches(
    parentNode: LainNode,
    exploration: Exploration,
    n: number
  ): Promise<string[] | undefined> {
    if (exploration.planDetail === "none") return undefined;

    const ancestors = this.graph.getAncestorChain(parentNode.id);

    const planContext: PlanContext = {
      parentNode,
      ancestors,
      exploration,
      n,
      detail: exploration.planDetail,
    };

    // Run before:plan hook
    if (this.extensions) {
      await this.extensions.runHook("before:plan", planContext);
    }

    this.emit({
      type: "plan:created",
      explorationId: exploration.id,
      nodeId: parentNode.id,
    });

    // Get extension plan prompt
    const extensionPlanPrompt = this.extensions
      ? this.extensions.getPlanPrompt(planContext, [exploration.extension])
      : undefined;

    const planResponse = await this.agent.plan({
      parentNode,
      ancestors,
      exploration,
      n,
      detail: exploration.planDetail,
      extensionPlanPrompt: extensionPlanPrompt || undefined,
    });

    // Run after:plan hook — extensions can modify directions
    let directions = planResponse.directions;
    if (this.extensions) {
      directions = await this.extensions.runAfterPlan(planContext, directions, [exploration.extension]);
    }

    this.emit({
      type: "plan:complete",
      explorationId: exploration.id,
      nodeId: parentNode.id,
      data: { directions },
    });

    return directions;
  }

  // ========================================================================
  // Generation
  // ========================================================================

  private async generateNode(
    node: LainNode,
    exploration: Exploration
  ): Promise<void> {
    this.storage.updateNodeStatus(node.id, "generating");
    this.emit({
      type: "node:generating",
      explorationId: exploration.id,
      nodeId: node.id,
    });

    const ancestors = this.graph.getAncestorChain(node.id);
    const siblings = this.graph.getSiblings(node.id);

    const nodeContext: NodeContext = {
      node,
      ancestors,
      siblings,
      exploration,
      depth: node.depth,
    };

    // Run before:generate hook
    if (this.extensions) {
      await this.extensions.runHook("before:generate", nodeContext);

      // Run before:generate validators
      const validation = this.extensions.runValidators("before:generate", nodeContext, undefined, [exploration.extension]);
      if (!validation.valid) {
        this.emit({
          type: "error",
          explorationId: exploration.id,
          nodeId: node.id,
          data: { error: `Validation failed: ${validation.errors.join("; ")}` },
        });
      }
    }

    // Get extension system prompt
    const extensionSystemPrompt = this.extensions
      ? this.extensions.getSystemPrompt(nodeContext, [exploration.extension])
      : undefined;

    try {
      let response = await this.agent.generate({
        node,
        ancestors,
        siblings: siblings.filter((s) => s.status === "complete"),
        exploration,
        extensionSystemPrompt: extensionSystemPrompt || undefined,
      });

      // Run after:generate hook — extensions can modify response
      if (this.extensions) {
        response = await this.extensions.runAfterGenerate(nodeContext, response, [exploration.extension]);

        // Run after:generate validators
        const validation = this.extensions.runValidators("after:generate", nodeContext, response, [exploration.extension]);
        if (!validation.valid) {
          for (const err of validation.errors) {
            this.emit({
              type: "error",
              explorationId: exploration.id,
              nodeId: node.id,
              data: { error: `Post-generation validation: ${err}` },
            });
          }
        }
      }

      this.storage.updateNodeContent(
        node.id,
        response.title,
        response.content,
        response.model,
        response.provider
      );

      this.emit({
        type: "node:complete",
        explorationId: exploration.id,
        nodeId: node.id,
        data: { title: response.title },
      });
    } catch (error) {
      this.storage.updateNodeStatus(node.id, "pending");

      // Run on:error hook
      if (this.extensions) {
        await this.extensions.runHook("on:error", error, { nodeId: node.id, explorationId: exploration.id });
      }

      this.emit({
        type: "error",
        explorationId: exploration.id,
        nodeId: node.id,
        data: { error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }

  /**
   * Generate a batch of nodes with concurrency limit.
   */
  private async generateNodesBatch(
    nodes: LainNode[],
    exploration: Exploration
  ): Promise<void> {
    await this.runConcurrent(
      nodes,
      (node) => this.generateNode(node, exploration),
      this.concurrency
    );
  }

  // ========================================================================
  // Concurrency helper
  // ========================================================================

  /**
   * Run async tasks with a concurrency limit.
   * Like Promise.all but at most `limit` tasks run simultaneously.
   */
  private async runConcurrent<T, R>(
    items: T[],
    fn: (item: T) => Promise<R>,
    limit: number
  ): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let nextIndex = 0;

    async function worker(): Promise<void> {
      while (nextIndex < items.length) {
        const i = nextIndex++;
        results[i] = await fn(items[i]);
      }
    }

    const workers = Array.from(
      { length: Math.min(limit, items.length) },
      () => worker()
    );
    await Promise.all(workers);
    return results;
  }

  // ========================================================================
  // Events
  // ========================================================================

  private emit(event: Omit<LainEvent, "timestamp">): void {
    this.onEvent({ ...event, timestamp: nowISO() } as LainEvent);
  }
}
