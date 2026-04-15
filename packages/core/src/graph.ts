import { Storage } from "./storage.js";
import type { LainNode, Exploration, Crosslink } from "@lain/shared";
import { buildNodeId, nowISO } from "@lain/shared";

/**
 * High-level graph operations on top of Storage.
 * Handles node creation with proper ID generation, ancestor chain building, etc.
 */
export class Graph {
  constructor(private storage: Storage) {}

  createExploration(params: {
    id: string;
    name: string;
    seed: string;
    n: number;
    m: number;
    strategy: Exploration["strategy"];
    planDetail: Exploration["planDetail"];
    extension: string;
  }): Exploration {
    const now = nowISO();
    const exploration: Exploration = {
      ...params,
      createdAt: now,
      updatedAt: now,
    };
    this.storage.createExploration(exploration);

    // Create root node
    const rootNode: LainNode = {
      id: "root",
      explorationId: params.id,
      parentId: null,
      content: params.seed,
      contentConflict: null,
      title: params.name,
      depth: 0,
      branchIndex: 0,
      status: "complete",
      model: null,
      provider: null,
      planSummary: null,
      extensionData: null,
      createdAt: now,
      updatedAt: now,
    };
    this.storage.createNode(rootNode);

    return exploration;
  }

  /**
   * Create pending child nodes for a parent.
   * Returns the created nodes (status: pending).
   */
  createChildNodes(
    explorationId: string,
    parentId: string,
    count: number,
    planSummaries?: string[]
  ): LainNode[] {
    const now = nowISO();
    const parent = this.storage.getNode(parentId);
    if (!parent) throw new Error(`Parent node not found: ${parentId}`);

    const existingChildren = this.storage.getChildren(parentId);
    const startIndex = existingChildren.length + 1;

    const nodes: LainNode[] = [];
    for (let i = 0; i < count; i++) {
      const branchIndex = startIndex + i;
      const node: LainNode = {
        id: buildNodeId(parentId, branchIndex),
        explorationId,
        parentId,
        content: null,
        contentConflict: null,
        title: null,
        depth: parent.depth + 1,
        branchIndex,
        status: "pending",
        model: null,
        provider: null,
        planSummary: planSummaries?.[i] ?? null,
        extensionData: null,
        createdAt: now,
        updatedAt: now,
      };
      this.storage.createNode(node);
      nodes.push(node);
    }
    return nodes;
  }

  getAncestorChain(nodeId: string): LainNode[] {
    return this.storage.getAncestors(nodeId);
  }

  getSiblings(nodeId: string): LainNode[] {
    const node = this.storage.getNode(nodeId);
    if (!node?.parentId) return [];
    return this.storage
      .getChildren(node.parentId)
      .filter((n) => n.id !== nodeId);
  }

  /**
   * Get all nodes at a given depth for an exploration.
   */
  getNodesAtDepth(explorationId: string, depth: number): LainNode[] {
    return this.storage
      .getNodesByExploration(explorationId)
      .filter((n) => n.depth === depth);
  }

  /**
   * Get all pending nodes for an exploration, ordered for BF or DF traversal.
   */
  getPendingNodes(
    explorationId: string,
    strategy: "bf" | "df"
  ): LainNode[] {
    const pending = this.storage.getNodesByStatus(explorationId, "pending");
    if (strategy === "bf") {
      // Already ordered by depth, branch_index from the query
      return pending;
    }
    // DF: sort by depth descending (deepest first), then by branch_index
    // Actually for DF we want to go deep along one path first.
    // Sort: prioritize nodes whose ancestors have the lowest branch indices.
    return pending.sort((a, b) => {
      // For DF, we pick the shallowest pending node along the leftmost path first
      // But actually DF means we go deep before wide — so pick the deepest node
      // that's along the currently active path.
      // Simplest correct approach: sort by ID lexicographically (root-1-1-1 before root-2)
      return a.id.localeCompare(b.id);
    });
  }

  addCrosslink(
    sourceId: string,
    targetId: string,
    label?: string,
    aiSuggested = false
  ): void {
    const link: Crosslink = {
      sourceId,
      targetId,
      label: label ?? null,
      aiSuggested,
      createdAt: nowISO(),
    };
    this.storage.createCrosslink(link);
  }

  pruneNode(nodeId: string): void {
    this.storage.pruneNode(nodeId);
  }

  getExploration(id: string): Exploration | null {
    return this.storage.getExploration(id);
  }

  getAllExplorations(): Exploration[] {
    return this.storage.getExplorationsAll();
  }

  getNode(id: string): LainNode | null {
    return this.storage.getNode(id);
  }

  getAllNodes(explorationId: string): LainNode[] {
    return this.storage.getNodesByExploration(explorationId);
  }

  getCrosslinks(explorationId: string): Crosslink[] {
    return this.storage.getCrosslinksForExploration(explorationId);
  }

  getConflicts(explorationId: string): LainNode[] {
    return this.storage
      .getNodesByExploration(explorationId)
      .filter((n) => n.contentConflict !== null);
  }
}
