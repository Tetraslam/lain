import { Graph } from "./graph.js";
import { Storage } from "./storage.js";
import type {
  AgentProvider,
  Exploration,
  LainEvent,
  LainEventHandler,
  LainNode,
  Strategy,
} from "@lain/shared";
import { nowISO } from "@lain/shared";

export interface OrchestratorOptions {
  dbPath: string;
  agent: AgentProvider;
  onEvent?: LainEventHandler;
}

/**
 * Manages the expansion loop: creates pending nodes, generates content via agents,
 * respects BF/DF strategy.
 */
export class Orchestrator {
  private storage: Storage;
  private graph: Graph;
  private agent: AgentProvider;
  private onEvent: LainEventHandler;

  constructor(options: OrchestratorOptions) {
    this.storage = new Storage(options.dbPath);
    this.graph = new Graph(this.storage);
    this.agent = options.agent;
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

    // Generate the tree
    await this.expandTree(exploration);

    this.emit({
      type: "exploration:complete",
      explorationId: exploration.id,
    });

    return exploration;
  }

  /**
   * Expand a single node with n new children.
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

    // Generate each child
    for (const child of children) {
      await this.generateNode(child, exploration);
    }

    return children.map((c) => this.graph.getNode(c.id)!);
  }

  private async expandTree(exploration: Exploration): Promise<void> {
    // Start from root, expand to depth m
    for (let depth = 0; depth < exploration.m; depth++) {
      const nodesAtDepth =
        depth === 0
          ? [this.graph.getNode("root")!]
          : this.graph.getNodesAtDepth(exploration.id, depth);

      const activeNodes = nodesAtDepth.filter(
        (n) => n.status === "complete"
      );

      for (const node of activeNodes) {
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

        if (exploration.strategy === "df") {
          // DF: generate first child, then recurse into it before siblings
          // For v0.1 sequential, just generate in order — true DF ordering
          // is handled by generating depth-first
          for (const child of children) {
            await this.generateNode(child, exploration);
          }
        } else {
          // BF: generate all children at this depth before going deeper
          for (const child of children) {
            await this.generateNode(child, exploration);
          }
        }
      }
    }
  }

  private async planBranches(
    parentNode: LainNode,
    exploration: Exploration,
    n: number
  ): Promise<string[] | undefined> {
    if (exploration.planDetail === "none") return undefined;

    const ancestors = this.graph.getAncestorChain(parentNode.id);

    this.emit({
      type: "plan:created",
      explorationId: exploration.id,
      nodeId: parentNode.id,
    });

    const planResponse = await this.agent.plan({
      parentNode,
      ancestors,
      exploration,
      n,
      detail: exploration.planDetail,
    });

    this.emit({
      type: "plan:complete",
      explorationId: exploration.id,
      nodeId: parentNode.id,
      data: { directions: planResponse.directions },
    });

    return planResponse.directions;
  }

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

    try {
      const response = await this.agent.generate({
        node,
        ancestors,
        siblings: siblings.filter((s) => s.status === "complete"),
        exploration,
      });

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
      this.emit({
        type: "error",
        explorationId: exploration.id,
        nodeId: node.id,
        data: { error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }

  private emit(event: Omit<LainEvent, "timestamp">): void {
    this.onEvent({ ...event, timestamp: nowISO() } as LainEvent);
  }
}
