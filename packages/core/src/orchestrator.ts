import { Graph } from "./graph.js";
import { Storage } from "./storage.js";
import { Corpus } from "./corpus.js";
import { generateNodeAgentic } from "./agentic.js";
import { validateMission, planMissionRevisions } from "./mission.js";
import type { LainTool } from "./tools.js";
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
  AgentStepEvent,
  ExtensionTool,
  MissionReport,
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
  getTools?(activeExtensions?: string[]): ExtensionTool[];
  get?(name: string): { requiresWebSearch?: boolean } | undefined;
}

export interface OrchestratorOptions {
  dbPath: string;
  agent: AgentProvider;
  concurrency?: number;
  extensions?: ExtensionRegistryLike;
  onEvent?: LainEventHandler;
  /** Max agent steps (tool round-trips) per node. Default 10. */
  agentMaxSteps?: number;
  /** Max output tokens per agent turn. Default 16384 (node bodies are long; a small cap truncates submit_node). */
  agentMaxTokens?: number;
  /** Shared corpus for retrieval tools (created from the same db if omitted). */
  corpus?: Corpus | null;
  /** Extra tools contributed by extensions / MCP servers. */
  extraTools?: LainTool[];
  /** Tool ids to drop from the agentic toolbelt (resolved per-run/config selection). */
  disabledTools?: string[];
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
  private ownsStorage: boolean;
  private agentMaxSteps: number;
  private agentMaxTokens: number;
  private corpus: Corpus | null;
  private extraTools: LainTool[];
  private disabledTools: string[];

  constructor(options: OrchestratorOptions) {
    this.storage = new Storage(options.dbPath);
    this.ownsStorage = true;
    this.graph = new Graph(this.storage);
    this.agent = options.agent;
    this.concurrency = options.concurrency ?? 5;
    this.extensions = options.extensions ?? null;
    this.onEvent = options.onEvent ?? (() => {});
    this.agentMaxSteps = options.agentMaxSteps ?? 10;
    this.agentMaxTokens = options.agentMaxTokens ?? 16384;
    // Reuse the orchestrator's Storage for the corpus so they share one db handle.
    this.corpus = options.corpus ?? new Corpus(this.storage);
    this.extraTools = options.extraTools ?? [];
    this.disabledTools = options.disabledTools ?? [];
  }

  getCorpus(): Corpus | null {
    return this.corpus;
  }

  close(): void {
    if (this.ownsStorage) {
      this.storage.close();
    }
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
    /**
     * Runs after the exploration row exists but before any generation — the
     * place to ingest corpus material so node-agents can retrieve from it.
     */
    beforeExpand?: (exploration: Exploration) => Promise<void> | void;
  }): Promise<Exploration> {
    const exploration = this.graph.createExploration(params);

    this.emit({
      type: "exploration:created",
      explorationId: exploration.id,
    });

    if (params.beforeExpand) {
      await params.beforeExpand(exploration);
    }

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

  /**
   * Resume an interrupted exploration: generate every node that isn't complete
   * and create+generate any children that were never produced — so a killed run
   * is never lossy. Idempotent: a no-op on a fully-complete exploration.
   */
  async resume(explorationId: string): Promise<{ generated: number; created: number }> {
    const exploration = this.graph.getExploration(explorationId);
    if (!exploration) throw new Error(`Exploration not found: ${explorationId}`);

    let generated = 0;
    let created = 0;

    for (let depth = 0; depth <= exploration.m; depth++) {
      const nodesAtDepth =
        depth === 0
          ? [this.graph.getNode("root")].filter((n): n is LainNode => !!n)
          : this.graph.getNodesAtDepth(explorationId, depth);

      // 1) Generate any incomplete (pending/generating) nodes at this depth.
      const incomplete = nodesAtDepth.filter(
        (n) => n.status !== "complete" && n.status !== "pruned"
      );
      if (incomplete.length > 0) {
        await this.generateNodesBatch(incomplete, exploration);
        generated += incomplete.length;
      }

      // 2) Below the last depth, ensure every complete node has its children.
      if (depth < exploration.m) {
        const parents = (
          depth === 0
            ? [this.graph.getNode("root")].filter((n): n is LainNode => !!n)
            : this.graph.getNodesAtDepth(explorationId, depth)
        ).filter((n) => n.status === "complete");

        const needChildren = parents.filter(
          (p) => this.storage.getChildren(p.id).filter((c) => c.status !== "pruned").length === 0
        );

        if (needChildren.length > 0) {
          const planResults = await this.runConcurrent(
            needChildren,
            async (node) => ({ node, summaries: await this.planBranches(node, exploration, exploration.n) }),
            this.concurrency
          );
          for (const { node, summaries } of planResults) {
            const children = this.graph.createChildNodes(explorationId, node.id, exploration.n, summaries);
            created += children.length;
          }
          // These children get generated when the loop reaches depth + 1.
        }
      }
    }

    this.emit({ type: "exploration:complete", explorationId });
    return { generated, created };
  }

  /**
   * Pursue a mission to completion: independently validate the graph against the
   * contract, then autonomously generate targeted fix-branches for unmet
   * assertions and re-validate — looping until the contract is satisfied or the
   * round budget is hit. This is the "run until the goal is met" part.
   */
  async pursueMission(
    explorationId: string,
    opts: { maxRounds?: number; maxFixesPerRound?: number } = {}
  ): Promise<MissionReport | null> {
    const exploration = this.graph.getExploration(explorationId);
    if (!exploration) throw new Error(`Exploration not found: ${explorationId}`);
    const mission = this.storage.getMission(explorationId);
    if (!mission || mission.assertions.length === 0) return null;

    const maxRounds = opts.maxRounds ?? 2;
    const maxFixes = opts.maxFixesPerRound ?? 2;

    // Round 0: initial validation of what `explore` produced.
    let report = await validateMission(this.agent, this.graph, exploration, mission, 0);
    this.storage.addMissionReport(report);
    this.emit({ type: "mission:validated", explorationId, data: { round: report.round, satisfied: report.satisfied, results: report.results, summary: report.summary } });

    for (let round = 1; round <= maxRounds && !report.satisfied; round++) {
      // Close gaps by REVISING the nodes the validator flagged — not by adding
      // new nodes. The mission's job is to make the existing graph satisfy the
      // contract, so a failed assertion sends its responsible node back to its
      // author with the validator's critique.
      const revisions = await planMissionRevisions(this.agent, this.graph, exploration, mission, report, maxFixes);
      if (revisions.length === 0) break;

      for (const rev of revisions) {
        const node = this.graph.getNode(rev.nodeId);
        if (!node) continue;
        const assertions = mission.assertions
          .filter((a) => rev.assertions.includes(a.id))
          .map((a) => ({ id: a.id, text: a.text }));
        this.emit({ type: "mission:fix", explorationId, nodeId: node.id, data: { assertions: rev.assertions, critique: rev.critique } });
        await this.generateNode(this.graph.getNode(rev.nodeId)!, exploration, { assertions, critique: rev.critique });
      }

      report = await validateMission(this.agent, this.graph, exploration, mission, round);
      this.storage.addMissionReport(report);
      this.emit({ type: "mission:validated", explorationId, data: { round: report.round, satisfied: report.satisfied, results: report.results, summary: report.summary } });
    }

    return report;
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

    // Mission: the root's branches are decided up-front by the contract's
    // features (front-loaded decomposition), not generic divergent planning.
    if (parentNode.id === "root") {
      const mission = this.storage.getMission(exploration.id);
      if (mission && mission.features.length > 0) {
        const angles = mission.features.map((f) =>
          f.assertions.length ? `${f.angle} (fulfilling ${f.assertions.join(", ")})` : f.angle
        );
        // Pad/trim to n so the tree shape is respected.
        while (angles.length < n) angles.push(mission.features[angles.length % mission.features.length].angle);
        return angles.slice(0, n);
      }
    }

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
    exploration: Exploration,
    revision?: { assertions: { id: string; text: string }[]; critique: string }
  ): Promise<void> {
    this.storage.updateNodeStatus(node.id, "generating");
    // Citations are per-(re)generation: clear any stale ones so a redirected or
    // revised node re-grounds from scratch instead of accumulating dead markers.
    this.storage.clearNodeCitations(node.id);
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
      // Every node is expanded by a tool-using agent (the substrate): it can
      // read the graph, retrieve from the corpus, search/cite the web, and link
      // across branches.
      let response: GenerateResponse = await generateNodeAgentic(node, {
        agent: this.agent,
        graph: this.graph,
        storage: this.storage,
        corpus: this.corpus,
        exploration,
        mission: this.storage.getMission(exploration.id),
        extensionSystemPrompt: extensionSystemPrompt || undefined,
        extraTools: this.extraTools,
        extensionTools: this.extensions?.getTools
          ? this.extensions.getTools([exploration.extension])
          : [],
        disabledTools: this.disabledTools,
        citations: this.extensions?.get?.(exploration.extension)?.requiresWebSearch ?? false,
        revision,
        maxSteps: this.agentMaxSteps,
        maxTokens: this.agentMaxTokens,
        onStep: (step: AgentStepEvent) =>
          this.emit({
            type: "node:agent-step",
            explorationId: exploration.id,
            nodeId: node.id,
            data: step,
          }),
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
