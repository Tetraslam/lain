import { Storage } from "./storage.js";
import { Graph } from "./graph.js";
import type { LainNode, Crosslink } from "@lain/shared";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// Obsidian Canvas (.canvas) JSON format types
// ============================================================================

interface CanvasNode {
  id: string;
  type: "text" | "file" | "link" | "group";
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  // text node
  text?: string;
  // file node
  file?: string;
  subpath?: string;
  // group node
  label?: string;
}

interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: "top" | "right" | "bottom" | "left";
  fromEnd?: "none" | "arrow";
  toNode: string;
  toSide?: "top" | "right" | "bottom" | "left";
  toEnd?: "none" | "arrow";
  color?: string;
  label?: string;
}

interface Canvas {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

// ============================================================================
// Layout configuration
// ============================================================================

/** Depth-based colors (Obsidian preset numbers). */
const DEPTH_COLORS: Record<number, string> = {
  0: "6", // purple — root/origin
  1: "5", // cyan
  2: "4", // green
  3: "3", // yellow
};

const CROSSLINK_COLOR = "2"; // orange — visually distinct from tree edges

/** Node dimensions. */
const ROOT_WIDTH = 400;
const ROOT_HEIGHT = 200;
const NODE_WIDTH = 300;
const NODE_HEIGHT = 100;

/** Base spacing between depth rings in the radial layout. */
const BASE_RING_SPACING = 450;

/**
 * Minimum arc-length (px) between adjacent node centers at the same depth.
 * Must be >= node diagonal to prevent overlap.
 */
const MIN_ARC_LENGTH = Math.sqrt(NODE_WIDTH * NODE_WIDTH + NODE_HEIGHT * NODE_HEIGHT) + 40;

// ============================================================================
// Radial layout engine
// ============================================================================

interface LayoutNode {
  node: LainNode;
  x: number;
  y: number;
  angle: number; // radians from center, for edge routing
}

/**
 * Compute radial positions for all nodes.
 *
 * Root at (0,0). Children placed in a ring at computed radius, evenly
 * spaced. Each child's subtree fans outward within the angular wedge
 * allocated to that child.
 *
 * Ring radii are computed dynamically: the radius for each depth is the
 * larger of (depth * BASE_RING_SPACING) and (the radius needed so that
 * all nodes at that depth fit without overlap on the circumference).
 */
function computeRadialLayout(
  root: LainNode,
  allNodes: LainNode[]
): Map<string, LayoutNode> {
  const layout = new Map<string, LayoutNode>();
  const childrenOf = buildChildMap(allNodes);

  // Root at center
  layout.set(root.id, {
    node: root,
    x: -ROOT_WIDTH / 2,
    y: -ROOT_HEIGHT / 2,
    angle: 0,
  });

  // Count total leaf descendants for each node (used for proportional angle allocation)
  const leafCounts = new Map<string, number>();
  function countLeaves(nodeId: string): number {
    const children = childrenOf.get(nodeId) ?? [];
    if (children.length === 0) {
      leafCounts.set(nodeId, 1);
      return 1;
    }
    let total = 0;
    for (const child of children) {
      total += countLeaves(child.id);
    }
    leafCounts.set(nodeId, total);
    return total;
  }
  countLeaves(root.id);

  // Count nodes at each depth to compute required radii
  const nodesPerDepth = new Map<number, number>();
  for (const node of allNodes) {
    if (node.status === "pruned") continue;
    if (node.depth === 0) continue; // root is at center
    nodesPerDepth.set(
      node.depth,
      (nodesPerDepth.get(node.depth) ?? 0) + 1
    );
  }

  // Compute radius for each depth:
  // radius must be large enough that (count * MIN_ARC_LENGTH) fits on the circumference
  // i.e., radius >= (count * MIN_ARC_LENGTH) / (2 * π)
  // and also at least depth * BASE_RING_SPACING for visual spacing
  const depthRadius = new Map<number, number>();
  const depths = [...nodesPerDepth.keys()].sort((a, b) => a - b);
  let prevRadius = 0;
  for (const depth of depths) {
    const count = nodesPerDepth.get(depth)!;
    const minRadiusForCount = (count * MIN_ARC_LENGTH) / (2 * Math.PI);
    const baseRadius = depth * BASE_RING_SPACING;
    // Must be larger than previous ring + some minimum gap
    const minRadiusForOrdering = prevRadius + BASE_RING_SPACING * 0.6;
    const radius = Math.max(baseRadius, minRadiusForCount, minRadiusForOrdering);
    depthRadius.set(depth, radius);
    prevRadius = radius;
  }

  // Lay out children recursively
  function layoutChildren(
    parentId: string,
    depth: number,
    angleStart: number,
    angleEnd: number
  ): void {
    const children = childrenOf.get(parentId) ?? [];
    if (children.length === 0) return;

    const radius = depthRadius.get(depth) ?? depth * BASE_RING_SPACING;
    const totalLeaves = children.reduce(
      (sum, c) => sum + (leafCounts.get(c.id) ?? 1),
      0
    );
    const angleSpan = angleEnd - angleStart;

    let currentAngle = angleStart;

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const childLeaves = leafCounts.get(child.id) ?? 1;

      // Proportional to leaf count — wider subtrees get more angular space
      const childAngleSpan = (childLeaves / totalLeaves) * angleSpan;

      const childAngle = currentAngle + childAngleSpan / 2;
      const x = Math.cos(childAngle) * radius - NODE_WIDTH / 2;
      const y = Math.sin(childAngle) * radius - NODE_HEIGHT / 2;

      layout.set(child.id, {
        node: child,
        x: Math.round(x),
        y: Math.round(y),
        angle: childAngle,
      });

      // Recurse into child's subtree with its allocated angular wedge
      layoutChildren(
        child.id,
        depth + 1,
        currentAngle,
        currentAngle + childAngleSpan
      );

      currentAngle += childAngleSpan;
    }
  }

  layoutChildren(root.id, 1, 0, 2 * Math.PI);

  return layout;
}

/**
 * Build a map of parentId → sorted children (excluding pruned).
 */
function buildChildMap(allNodes: LainNode[]): Map<string, LainNode[]> {
  const map = new Map<string, LainNode[]>();
  for (const node of allNodes) {
    if (node.status === "pruned") continue;
    if (node.parentId) {
      const siblings = map.get(node.parentId) ?? [];
      siblings.push(node);
      map.set(node.parentId, siblings);
    }
  }
  // Sort children by branchIndex
  for (const [, children] of map) {
    children.sort((a, b) => a.branchIndex - b.branchIndex);
  }
  return map;
}

/**
 * Determine which side of a node faces toward a given angle from center.
 * Used for edge routing — connects from the side facing the other node.
 */
function sideFromAngle(
  fromLayout: LayoutNode,
  toLayout: LayoutNode
): { fromSide: CanvasEdge["fromSide"]; toSide: CanvasEdge["toSide"] } {
  const dx = (toLayout.x + NODE_WIDTH / 2) - (fromLayout.x + (fromLayout.node.parentId === null ? ROOT_WIDTH : NODE_WIDTH) / 2);
  const dy = (toLayout.y + NODE_HEIGHT / 2) - (fromLayout.y + (fromLayout.node.parentId === null ? ROOT_HEIGHT : NODE_HEIGHT) / 2);

  // From node: side facing toward the to node
  const fromSide = pickSide(dx, dy);
  // To node: side facing back toward the from node
  const toSide = pickSide(-dx, -dy);

  return { fromSide, toSide };
}

function pickSide(dx: number, dy: number): "top" | "right" | "bottom" | "left" {
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx > 0 ? "right" : "left";
  }
  return dy > 0 ? "bottom" : "top";
}

// ============================================================================
// Canvas exporter
// ============================================================================

export class CanvasExporter {
  private graph: Graph;

  constructor(private storage: Storage, graph?: Graph) {
    this.graph = graph ?? new Graph(storage);
  }

  /**
   * Export an exploration to an Obsidian .canvas file.
   *
   * @param explorationId  The exploration to export
   * @param outputPath     Path to write the .canvas file
   * @param mdFolderRel    Relative path from the .canvas file to the markdown files folder.
   *                       If markdown files are in a sibling folder, e.g. "exploration-name/root.md",
   *                       pass "exploration-name". If not provided, file nodes use just the node ID
   *                       (works when .canvas is in the same folder as the .md files).
   */
  export(explorationId: string, outputPath: string, mdFolderRel?: string): void {
    const exploration = this.graph.getExploration(explorationId);
    if (!exploration) throw new Error(`Exploration not found: ${explorationId}`);

    const allNodes = this.graph.getAllNodes(explorationId);
    const crosslinks = this.graph.getCrosslinks(explorationId);
    const activeNodes = allNodes.filter((n) => n.status !== "pruned");

    if (activeNodes.length === 0) {
      throw new Error("No active nodes to export.");
    }

    const canvas = this.buildCanvas(activeNodes, crosslinks, mdFolderRel);

    // Ensure parent directory exists
    const dir = path.dirname(outputPath);
    if (dir && dir !== ".") {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, JSON.stringify(canvas, null, 2));
  }

  /**
   * Build the canvas JSON without writing to disk.
   * Useful for testing and programmatic use.
   */
  buildCanvas(
    activeNodes: LainNode[],
    crosslinks: Crosslink[],
    mdFolderRel?: string
  ): Canvas {
    const root = activeNodes.find((n) => n.parentId === null);
    if (!root) throw new Error("No root node found.");

    // Compute layout
    const layout = computeRadialLayout(root, activeNodes);

    // Build canvas nodes
    const canvasNodes: CanvasNode[] = [];
    const canvasEdges: CanvasEdge[] = [];

    for (const [nodeId, layoutNode] of layout) {
      const node = layoutNode.node;
      const isRoot = node.parentId === null;

      if (isRoot) {
        // Root: text node showing the seed directly
        canvasNodes.push({
          id: nodeId,
          type: "text",
          x: layoutNode.x,
          y: layoutNode.y,
          width: ROOT_WIDTH,
          height: ROOT_HEIGHT,
          color: DEPTH_COLORS[0],
          text: `# ${node.title ?? "Root"}\n\n${node.content ?? ""}`,
        });
      } else {
        // Non-root: text node with title + wikilink to the full note
        const filePath = mdFolderRel
          ? `${mdFolderRel}/${nodeId}.md`
          : `${nodeId}.md`;

        const title = node.title ?? nodeId;
        const link = `[[${filePath.replace(/\.md$/, "")}|→ open note]]`;
        // Show plan summary as a brief preview if available
        const preview = node.planSummary
          ? `\n\n${node.planSummary}`
          : "";

        canvasNodes.push({
          id: nodeId,
          type: "text",
          x: layoutNode.x,
          y: layoutNode.y,
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          color: DEPTH_COLORS[node.depth] ?? undefined,
          text: `**${title}**${preview}\n\n${link}`,
        });
      }

      // Tree edge: parent → this node
      if (node.parentId && layout.has(node.parentId)) {
        const parentLayout = layout.get(node.parentId)!;
        const { fromSide, toSide } = sideFromAngle(parentLayout, layoutNode);

        canvasEdges.push({
          id: `edge-${node.parentId}-${nodeId}`,
          fromNode: node.parentId,
          fromSide,
          fromEnd: "none",
          toNode: nodeId,
          toSide,
          toEnd: "arrow",
        });
      }
    }

    // Crosslink edges
    for (const cl of crosslinks) {
      const sourceLayout = layout.get(cl.sourceId);
      const targetLayout = layout.get(cl.targetId);
      if (!sourceLayout || !targetLayout) continue; // skip if either node is pruned

      const { fromSide, toSide } = sideFromAngle(sourceLayout, targetLayout);

      canvasEdges.push({
        id: `crosslink-${cl.sourceId}-${cl.targetId}`,
        fromNode: cl.sourceId,
        fromSide,
        fromEnd: "arrow",
        toNode: cl.targetId,
        toSide,
        toEnd: "arrow",
        color: CROSSLINK_COLOR,
        label: cl.label ?? undefined,
      });
    }

    return { nodes: canvasNodes, edges: canvasEdges };
  }
}
