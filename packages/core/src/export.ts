import { Storage } from "./storage.js";
import { Graph } from "./graph.js";
import type { LainNode, Crosslink } from "@lain/shared";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * Exports an exploration from SQLite to obsidian-compatible markdown files.
 */
export class Exporter {
  private graph: Graph;

  constructor(private storage: Storage, graph?: Graph) {
    this.graph = graph ?? new Graph(storage);
  }

  /**
   * Export an exploration to a folder of markdown files.
   */
  export(explorationId: string, outputDir: string): void {
    const exploration = this.graph.getExploration(explorationId);
    if (!exploration) throw new Error(`Exploration not found: ${explorationId}`);

    const nodes = this.graph.getAllNodes(explorationId);
    const crosslinks = this.graph.getCrosslinks(explorationId);

    // Create output directory
    fs.mkdirSync(outputDir, { recursive: true });

    // Write _index.md
    const indexContent = this.renderIndex(exploration, nodes);
    fs.writeFileSync(path.join(outputDir, "_index.md"), indexContent);

    // Write each node
    for (const node of nodes) {
      if (node.status === "pruned") continue;
      const nodeCrosslinks = crosslinks.filter(
        (c) => c.sourceId === node.id || c.targetId === node.id
      );
      const children = nodes.filter((n) => n.parentId === node.id && n.status !== "pruned");
      const fileContent = this.renderNode(node, nodeCrosslinks, children);
      const fileName = `${node.id}.md`;
      fs.writeFileSync(path.join(outputDir, fileName), fileContent);
    }
  }

  renderIndex(
    exploration: ReturnType<Graph["getExploration"]> & {},
    nodes: LainNode[]
  ): string {
    const activeNodes = nodes.filter((n) => n.status !== "pruned");
    const maxDepth = Math.max(...activeNodes.map((n) => n.depth));

    const lines = [
      "---",
      `id: ${exploration.id}`,
      `name: ${exploration.name}`,
      `n: ${exploration.n}`,
      `m: ${exploration.m}`,
      `strategy: ${exploration.strategy}`,
      `extension: ${exploration.extension}`,
      `created: ${exploration.createdAt}`,
      "---",
      "",
      `# ${exploration.name}`,
      "",
      `> ${exploration.seed}`,
      "",
      `**Nodes:** ${activeNodes.length} | **Max depth:** ${maxDepth} | **Branches per node:** ${exploration.n}`,
      "",
      "## Tree",
      "",
    ];

    // Render tree structure
    const root = nodes.find((n) => n.parentId === null);
    if (root) {
      lines.push(...this.renderTreeLines(root, nodes, ""));
    }

    return lines.join("\n") + "\n";
  }

  private renderTreeLines(
    node: LainNode,
    allNodes: LainNode[],
    prefix: string
  ): string[] {
    const lines: string[] = [];
    const display = node.title || node.id;
    lines.push(`${prefix}- [[${node.id}|${display}]]`);

    const children = allNodes
      .filter((n) => n.parentId === node.id && n.status !== "pruned")
      .sort((a, b) => a.branchIndex - b.branchIndex);

    for (const child of children) {
      lines.push(...this.renderTreeLines(child, allNodes, prefix + "  "));
    }

    return lines;
  }

  renderNode(
    node: LainNode,
    crosslinks: Crosslink[],
    children: LainNode[]
  ): string {
    const fm = this.buildFrontmatter(node, crosslinks, children);
    const body = this.buildBody(node, crosslinks, children);
    return `${fm}\n${body}\n`;
  }

  private buildFrontmatter(
    node: LainNode,
    crosslinks: Crosslink[],
    children: LainNode[]
  ): string {
    const lines = ["---"];
    lines.push(`id: ${node.id}`);
    if (node.parentId) lines.push(`parent: ${node.parentId}`);
    if (children.length > 0) {
      lines.push(
        `children: [${children.map((c) => c.id).join(", ")}]`
      );
    }
    const crosslinkIds = crosslinks
      .map((c) => (c.sourceId === node.id ? c.targetId : c.sourceId))
      .filter((id) => id !== node.id);
    if (crosslinkIds.length > 0) {
      lines.push(`crosslinks: [${crosslinkIds.join(", ")}]`);
    }
    lines.push(`depth: ${node.depth}`);
    lines.push(`branch_index: ${node.branchIndex}`);
    if (node.model) lines.push(`model: ${node.model}`);
    if (node.provider) lines.push(`provider: ${node.provider}`);
    lines.push(`status: ${node.status}`);
    lines.push(`created: ${node.createdAt}`);
    lines.push("---");
    return lines.join("\n");
  }

  private buildBody(
    node: LainNode,
    crosslinks: Crosslink[],
    children: LainNode[]
  ): string {
    const lines: string[] = [];

    // Title
    lines.push(`# ${node.title || node.id}`);
    lines.push("");

    // Parent link
    if (node.parentId) {
      const parent = this.graph.getNode(node.parentId);
      const parentDisplay = parent?.title || node.parentId;
      lines.push(`[[${node.parentId}|parent: ${parentDisplay}]]`);
      lines.push("");
    }

    // Content
    if (node.content) {
      lines.push(node.content);
      lines.push("");
    }

    // Cross-links
    if (crosslinks.length > 0) {
      lines.push("## Cross-links");
      for (const cl of crosslinks) {
        const otherId =
          cl.sourceId === node.id ? cl.targetId : cl.sourceId;
        const otherNode = this.graph.getNode(otherId);
        const display = otherNode?.title || otherId;
        const label = cl.label ? ` — ${cl.label}` : "";
        lines.push(`- [[${otherId}|${display}]]${label}`);
      }
      lines.push("");
    }

    // Children
    if (children.length > 0) {
      lines.push("## Children");
      for (const child of children) {
        const display = child.title || child.id;
        lines.push(`- [[${child.id}|${display}]]`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}

/**
 * Compute hash of a string. Used for sync state tracking.
 */
export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
