/**
 * Force-directed graph layout for the TUI graph view.
 * Uses FrameBufferRenderable for per-cell rendering.
 */
import {
  FrameBufferRenderable,
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  RGBA,
} from "@opentui/core";
import { t, fg, dim, bold } from "@opentui/core";
import type { RenderContext, KeyEvent } from "@opentui/core";
import type { LainNode, Crosslink } from "@lain/shared";

// ============================================================================
// Physics
// ============================================================================

interface GraphNode {
  id: string;
  title: string;
  depth: number;
  status: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  parentId: string | null;
  selected: boolean;
  pinned: boolean;
}

interface GraphEdge {
  source: string;
  target: string;
  isCrosslink: boolean;
}

const REPULSION = 800;
const ATTRACTION = 0.04;
const CROSSLINK_ATTRACTION = 0.01;
const DAMPING = 0.85;
const CENTER_GRAVITY = 0.002;
const MIN_DISTANCE = 4;

function simulate(nodes: GraphNode[], edges: GraphEdge[], width: number, height: number): void {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // Repulsion between all nodes
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), MIN_DISTANCE);
      const force = REPULSION / (dist * dist);
      dx = (dx / dist) * force;
      dy = (dy / dist) * force;
      if (!a.pinned) { a.vx += dx; a.vy += dy; }
      if (!b.pinned) { b.vx -= dx; b.vy -= dy; }
    }
  }

  // Attraction along edges
  for (const edge of edges) {
    const a = nodeMap.get(edge.source);
    const b = nodeMap.get(edge.target);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const k = edge.isCrosslink ? CROSSLINK_ATTRACTION : ATTRACTION;
    if (!a.pinned) { a.vx += dx * k; a.vy += dy * k; }
    if (!b.pinned) { b.vx -= dx * k; b.vy -= dy * k; }
  }

  // Center gravity
  const cx = width / 2;
  const cy = height / 2;
  for (const node of nodes) {
    if (node.pinned) continue;
    node.vx += (cx - node.x) * CENTER_GRAVITY;
    node.vy += (cy - node.y) * CENTER_GRAVITY;
  }

  // Apply velocity + damping
  for (const node of nodes) {
    if (node.pinned) continue;
    node.vx *= DAMPING;
    node.vy *= DAMPING;
    node.x += node.vx;
    node.y += node.vy;
    // Clamp to bounds
    node.x = Math.max(2, Math.min(width - 2, node.x));
    node.y = Math.max(1, Math.min(height - 2, node.y));
  }
}

// ============================================================================
// Colors
// ============================================================================

const gc = {
  bg: RGBA.fromHex("#1a1b26"),
  nodeBorder: RGBA.fromHex("#565f89"),
  nodeText: RGBA.fromHex("#c0caf5"),
  selectedBorder: RGBA.fromHex("#bb9af7"),
  selectedText: RGBA.fromHex("#ffffff"),
  selectedBg: RGBA.fromHex("#292e42"),
  edge: RGBA.fromHex("#3b3f5c"),
  crosslinkEdge: RGBA.fromHex("#7c6ea3"),
  rootBorder: RGBA.fromHex("#7aa2f7"),
  prunedText: RGBA.fromHex("#f7768e"),
  dim: RGBA.fromHex("#3b3f5c"),
};

// ============================================================================
// Rendering
// ============================================================================

function drawGraph(
  fb: FrameBufferRenderable,
  nodes: GraphNode[],
  edges: GraphEdge[],
  width: number,
  height: number
): void {
  const buf = fb.frameBuffer;
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const transparent = RGBA.fromValues(0, 0, 0, 0);

  // Clear
  buf.fillRect(0, 0, width, height, transparent);

  // Draw edges
  for (const edge of edges) {
    const a = nodeMap.get(edge.source);
    const b = nodeMap.get(edge.target);
    if (!a || !b) continue;
    const color = edge.isCrosslink ? gc.crosslinkEdge : gc.edge;
    const ch = edge.isCrosslink ? "·" : "·";
    drawLine(buf, Math.round(a.x), Math.round(a.y), Math.round(b.x), Math.round(b.y), ch, color, transparent);
  }

  // Draw nodes (selected last so it's on top)
  const sorted = [...nodes].sort((a, b) => (a.selected ? 1 : 0) - (b.selected ? 1 : 0));
  for (const node of sorted) {
    const nx = Math.round(node.x);
    const ny = Math.round(node.y);
    const label = node.title.length > 16 ? node.title.slice(0, 15) + "…" : node.title;
    const halfW = Math.floor(label.length / 2) + 1;

    // Node background
    const borderColor = node.selected ? gc.selectedBorder : node.depth === 0 ? gc.rootBorder : gc.nodeBorder;
    const textColor = node.selected ? gc.selectedText : node.status === "pruned" ? gc.prunedText : gc.nodeText;
    const bgColor = node.selected ? gc.selectedBg : transparent;

    // Draw node box: ╭─label─╮
    const boxW = label.length + 4;
    const startX = nx - Math.floor(boxW / 2);

    // Top border
    if (ny - 1 >= 0) {
      buf.setCell(startX, ny - 1, "╭", borderColor, bgColor);
      for (let i = 1; i < boxW - 1; i++) buf.setCell(startX + i, ny - 1, "─", borderColor, bgColor);
      buf.setCell(startX + boxW - 1, ny - 1, "╮", borderColor, bgColor);
    }
    // Middle: │ label │
    buf.setCell(startX, ny, "│", borderColor, bgColor);
    buf.setCell(startX + 1, ny, " ", textColor, bgColor);
    buf.drawText(label, startX + 2, ny, textColor, bgColor);
    buf.setCell(startX + label.length + 2, ny, " ", textColor, bgColor);
    buf.setCell(startX + boxW - 1, ny, "│", borderColor, bgColor);
    // Bottom border
    if (ny + 1 < height) {
      buf.setCell(startX, ny + 1, "╰", borderColor, bgColor);
      for (let i = 1; i < boxW - 1; i++) buf.setCell(startX + i, ny + 1, "─", borderColor, bgColor);
      buf.setCell(startX + boxW - 1, ny + 1, "╯", borderColor, bgColor);
    }
  }
}

/** Bresenham's line algorithm for terminal cells */
function drawLine(
  buf: any, x0: number, y0: number, x1: number, y1: number,
  ch: string, fg: RGBA, bg: RGBA
): void {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let steps = 0;

  while (true) {
    // Only draw every other cell for a dotted look
    if (steps % 2 === 0) buf.setCell(x0, y0, ch, fg, bg);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
    steps++;
    if (steps > 500) break; // safety
  }
}

// ============================================================================
// Graph View Component
// ============================================================================

export interface GraphViewOptions {
  renderer: RenderContext;
  nodes: LainNode[];
  crosslinks: Crosslink[];
  width: number;
  height: number;
  onNodeSelect?: (nodeId: string) => void;
}

export class GraphView {
  private fb: FrameBufferRenderable;
  private graphNodes: GraphNode[] = [];
  private edges: GraphEdge[] = [];
  private selectedIdx = 0;
  private animating = false;
  private interval: ReturnType<typeof setInterval> | null = null;
  private renderer: RenderContext;
  private width: number;
  private height: number;
  private onNodeSelect?: (nodeId: string) => void;

  // Peek panel
  private peekBox: BoxRenderable;
  private peekScroll: ScrollBoxRenderable;
  private peekText: TextRenderable;

  constructor(opts: GraphViewOptions) {
    this.renderer = opts.renderer;
    this.width = opts.width;
    this.height = opts.height;
    this.onNodeSelect = opts.onNodeSelect;

    // Build graph data
    this.buildGraphData(opts.nodes, opts.crosslinks);

    // Create framebuffer
    this.fb = new FrameBufferRenderable(this.renderer, {
      id: "graph-fb",
      width: this.width,
      height: this.height,
    });

    // Peek panel (shows on right side when a node is selected)
    this.peekBox = new BoxRenderable(this.renderer, {
      id: "graph-peek", width: 35, height: this.height,
      position: "absolute", right: 0, top: 0,
      border: true, borderStyle: "rounded", borderColor: "#bb9af7",
      backgroundColor: "#1a1b26",
      paddingLeft: 1, paddingRight: 1,
      flexDirection: "column", overflow: "hidden",
    });

    this.peekScroll = new ScrollBoxRenderable(this.renderer, {
      id: "graph-peek-scroll", scrollY: true, scrollX: false,
    });
    this.peekBox.add(this.peekScroll);

    this.peekText = new TextRenderable(this.renderer, {
      id: "graph-peek-text", content: "", width: "100%",
    });
    this.peekScroll.content.add(this.peekText);
  }

  private buildGraphData(nodes: LainNode[], crosslinks: Crosslink[]) {
    // Position nodes by depth (layered)
    const depthGroups = new Map<number, LainNode[]>();
    for (const n of nodes) {
      if (n.status === "pruned") continue;
      const group = depthGroups.get(n.depth) || [];
      group.push(n);
      depthGroups.set(n.depth, group);
    }

    const maxDepth = Math.max(...Array.from(depthGroups.keys()), 0);

    for (const [depth, group] of depthGroups) {
      const yBase = (this.height / (maxDepth + 2)) * (depth + 1);
      const spacing = this.width / (group.length + 1);
      group.forEach((n, i) => {
        this.graphNodes.push({
          id: n.id,
          title: n.title || n.id,
          depth: n.depth,
          status: n.status,
          x: spacing * (i + 1) + (Math.random() - 0.5) * 4,
          y: yBase + (Math.random() - 0.5) * 2,
          vx: 0, vy: 0,
          parentId: n.parentId,
          selected: i === 0 && depth === 0,
          pinned: false,
        });
      });
    }

    // Parent edges
    for (const gn of this.graphNodes) {
      if (gn.parentId) {
        this.edges.push({ source: gn.parentId, target: gn.id, isCrosslink: false });
      }
    }

    // Crosslink edges
    for (const cl of crosslinks) {
      this.edges.push({ source: cl.sourceId, target: cl.targetId, isCrosslink: true });
    }

    if (this.graphNodes.length > 0) this.graphNodes[0].selected = true;
  }

  getRenderables(): { fb: FrameBufferRenderable; peek: BoxRenderable } {
    return { fb: this.fb, peek: this.peekBox };
  }

  start() {
    this.animating = true;
    (this.renderer as any).requestLive?.();
    this.interval = setInterval(() => {
      if (!this.animating) return;
      simulate(this.graphNodes, this.edges, this.width, this.height);
      drawGraph(this.fb, this.graphNodes, this.edges, this.width, this.height);
    }, 50); // 20fps
  }

  stop() {
    this.animating = false;
    if (this.interval) clearInterval(this.interval);
    (this.renderer as any).dropLive?.();
  }

  handleKey(key: KeyEvent) {
    const activeNodes = this.graphNodes.filter((n) => n.status !== "pruned");
    if (activeNodes.length === 0) return;

    switch (key.name) {
      case "j": case "down": {
        activeNodes[this.selectedIdx].selected = false;
        this.selectedIdx = (this.selectedIdx + 1) % activeNodes.length;
        activeNodes[this.selectedIdx].selected = true;
        this.updatePeek(activeNodes[this.selectedIdx]);
        break;
      }
      case "k": case "up": {
        activeNodes[this.selectedIdx].selected = false;
        this.selectedIdx = (this.selectedIdx - 1 + activeNodes.length) % activeNodes.length;
        activeNodes[this.selectedIdx].selected = true;
        this.updatePeek(activeNodes[this.selectedIdx]);
        break;
      }
      case "return": {
        const node = activeNodes[this.selectedIdx];
        this.onNodeSelect?.(node.id);
        break;
      }
    }
  }

  private updatePeek(node: GraphNode) {
    this.peekText.content = t`${bold(fg("#c0caf5")(node.title))}

${fg("#7aa2f7")("id")}  ${node.id}
${fg("#7aa2f7")("depth")}  ${String(node.depth)}
${fg("#7aa2f7")("status")}  ${node.status}
`;
    this.peekScroll.scrollTop = 0;
  }

  selectNode(nodeId: string) {
    const activeNodes = this.graphNodes.filter((n) => n.status !== "pruned");
    const idx = activeNodes.findIndex((n) => n.id === nodeId);
    if (idx >= 0) {
      if (this.selectedIdx < activeNodes.length) activeNodes[this.selectedIdx].selected = false;
      this.selectedIdx = idx;
      activeNodes[idx].selected = true;
      this.updatePeek(activeNodes[idx]);
    }
  }
}
