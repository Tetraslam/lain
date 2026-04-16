/**
 * Radial tree graph view for the TUI.
 *
 * Layout: root at center, children in a ring, grandchildren in arcs.
 * Gentle physics for organic drift. Peek panel beside the graph, not overlapping.
 */
import {
  FrameBufferRenderable,
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  RGBA,
} from "@opentui/core";
import { t, fg, bold } from "@opentui/core";
import type { RenderContext, KeyEvent, StyledText } from "@opentui/core";
import type { LainNode, Crosslink } from "@lain/shared";

// ============================================================================
// Types
// ============================================================================

interface GNode {
  id: string;
  title: string;
  shortTitle: string;
  depth: number;
  status: string;
  x: number;
  y: number;
  anchorX: number;
  anchorY: number;
  vx: number;
  vy: number;
  parentId: string | null;
}

interface GEdge {
  source: string;
  target: string;
  isCrosslink: boolean;
}

// ============================================================================
// Colors
// ============================================================================

const BG = RGBA.fromHex("#1a1b26");
const NODE_FG = RGBA.fromHex("#a9b1d6");
const SELECTED_FG = RGBA.fromHex("#1a1b26");
const SELECTED_BG = RGBA.fromHex("#bb9af7");
const ROOT_FG = RGBA.fromHex("#7aa2f7");
const EDGE_COLOR = RGBA.fromHex("#565f89");
const CROSSLINK_COLOR = RGBA.fromHex("#bb9af7");
const PRUNED_FG = RGBA.fromHex("#f7768e");

// ============================================================================
// Radial Tree Layout
// ============================================================================

function computeRadialLayout(
  lainNodes: LainNode[],
  w: number,
  h: number
): GNode[] {
  const active = lainNodes.filter((n) => n.status !== "pruned");
  if (active.length === 0) return [];

  const root = active.find((n) => n.parentId === null);
  if (!root) return [];

  // Build adjacency
  const childrenOf = new Map<string, LainNode[]>();
  for (const n of active) {
    if (n.parentId) {
      const siblings = childrenOf.get(n.parentId) || [];
      siblings.push(n);
      childrenOf.set(n.parentId, siblings);
    }
  }
  // Sort children by branch index
  for (const [, children] of childrenOf) {
    children.sort((a, b) => a.branchIndex - b.branchIndex);
  }

  const cx = w / 2;
  const cy = h / 2;

  // Terminal chars are ~2x taller than wide, so scale Y by 0.5
  const maxRadius = Math.min(w * 0.4, h * 0.8);
  const maxDepth = Math.max(...active.map((n) => n.depth), 0);
  const ringSpacing = maxDepth > 0 ? maxRadius / (maxDepth + 0.5) : maxRadius;

  const result: GNode[] = [];

  function layout(
    node: LainNode,
    angleStart: number,
    angleEnd: number,
    depth: number
  ) {
    const angle = (angleStart + angleEnd) / 2;
    const radius = depth * ringSpacing;

    const ax = cx + Math.cos(angle) * radius;
    const ay = cy + Math.sin(angle) * radius * 0.45; // Squash Y for terminal aspect ratio

    const shortTitle = node.title
      ? (node.title.length > 14 ? node.title.slice(0, 13) + "…" : node.title)
      : node.id;

    result.push({
      id: node.id,
      title: node.title || node.id,
      shortTitle,
      depth: node.depth,
      status: node.status,
      x: ax,
      y: ay,
      anchorX: ax,
      anchorY: ay,
      vx: 0,
      vy: 0,
      parentId: node.parentId,
    });

    const children = childrenOf.get(node.id) || [];
    if (children.length === 0) return;

    const arcSpan = angleEnd - angleStart;
    const childArc = arcSpan / children.length;

    children.forEach((child, i) => {
      const childStart = angleStart + childArc * i;
      const childEnd = childStart + childArc;
      layout(child, childStart, childEnd, depth + 1);
    });
  }

  // Root gets the full circle
  layout(root, 0, Math.PI * 2, 0);

  // Clamp all positions to buffer bounds
  for (const n of result) {
    n.x = Math.max(1, Math.min(w - 16, n.x));
    n.y = Math.max(1, Math.min(h - 2, n.y));
    n.anchorX = n.x;
    n.anchorY = n.y;
  }

  return result;
}

// ============================================================================
// Gentle Physics — just organic drift, no chaos
// ============================================================================

function simulate(nodes: GNode[], w: number, h: number): void {
  // Repel overlapping nodes at same depth
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const dx = a.x - b.x;
      const dy = (a.y - b.y) * 2;
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 3);
      if (dist < 15) {
        const force = 30 / (dist * dist);
        a.vx += (dx / dist) * force;
        a.vy += ((dy / 2) / dist) * force;
        b.vx -= (dx / dist) * force;
        b.vy -= ((dy / 2) / dist) * force;
      }
    }
  }

  // Spring to anchor
  for (const n of nodes) {
    n.vx += (n.anchorX - n.x) * 0.06;
    n.vy += (n.anchorY - n.y) * 0.06;
  }

  // Apply + damp + cap
  for (const n of nodes) {
    n.vx *= 0.7;
    n.vy *= 0.7;
    const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
    if (speed > 0.4) {
      n.vx = (n.vx / speed) * 0.4;
      n.vy = (n.vy / speed) * 0.4;
    }
    n.x += n.vx;
    n.y += n.vy;
    n.x = Math.max(1, Math.min(w - 16, n.x));
    n.y = Math.max(1, Math.min(h - 2, n.y));
  }
}

// ============================================================================
// Rendering
// ============================================================================

function renderGraph(
  fb: FrameBufferRenderable,
  nodes: GNode[],
  edges: GEdge[],
  selectedId: string,
  w: number,
  h: number
): void {
  const buf = fb.frameBuffer;
  const map = new Map(nodes.map((n) => [n.id, n]));

  buf.fillRect(0, 0, w, h, BG);

  // Draw edges
  for (const edge of edges) {
    const a = map.get(edge.source), b = map.get(edge.target);
    if (!a || !b) continue;
    const color = edge.isCrosslink ? CROSSLINK_COLOR : EDGE_COLOR;
    const ch = edge.isCrosslink ? ":" : "·";
    drawDottedLine(buf, Math.round(a.x), Math.round(a.y), Math.round(b.x), Math.round(b.y), ch, color, BG, edge.isCrosslink ? 1 : 2);
  }

  // Draw nodes — selected last for z-order
  const sorted = [...nodes].sort((a, b) => (a.id === selectedId ? 1 : 0) - (b.id === selectedId ? 1 : 0));
  for (const node of sorted) {
    const x = Math.round(node.x);
    const y = Math.round(node.y);
    const isSelected = node.id === selectedId;
    const label = ` ${node.shortTitle} `;

    if (isSelected) {
      buf.drawText(label, x, y, SELECTED_FG, SELECTED_BG);
    } else if (node.depth === 0) {
      buf.drawText(label, x, y, ROOT_FG, BG);
    } else if (node.status === "pruned") {
      buf.drawText(label, x, y, PRUNED_FG, BG);
    } else {
      buf.drawText(label, x, y, NODE_FG, BG);
    }
  }
}

function drawDottedLine(
  buf: any, x0: number, y0: number, x1: number, y1: number,
  ch: string, color: RGBA, bg: RGBA, spacing = 2
): void {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, steps = 0;
  while (true) {
    if (steps % spacing === 0) buf.setCell(x0, y0, ch, color, bg);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
    steps++;
    if (steps > 1000) break;
  }
}

// ============================================================================
// Graph View
// ============================================================================

export interface GraphViewOptions {
  renderer: RenderContext;
  nodes: LainNode[];
  crosslinks: Crosslink[];
  graphWidth: number;   // Width of the graph canvas (not including peek)
  graphHeight: number;
  onNodeSelect?: (nodeId: string) => void;
}

export class GraphView {
  private fb: FrameBufferRenderable;
  private graphNodes: GNode[] = [];
  private edges: GEdge[] = [];
  private selectedIdx = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private renderer: RenderContext;
  private gw: number;
  private gh: number;
  private onNodeSelect?: (nodeId: string) => void;
  private allLainNodes: LainNode[];

  // Peek panel — NOT overlapping, separate renderable
  peekBox: BoxRenderable;
  private peekScroll: ScrollBoxRenderable;
  private peekText: TextRenderable;

  constructor(opts: GraphViewOptions) {
    this.renderer = opts.renderer;
    this.gw = opts.graphWidth;
    this.gh = opts.graphHeight;
    this.onNodeSelect = opts.onNodeSelect;
    this.allLainNodes = opts.nodes;

    // Compute layout
    this.graphNodes = computeRadialLayout(opts.nodes, this.gw, this.gh);

    // Build edges
    for (const gn of this.graphNodes) {
      if (gn.parentId) {
        this.edges.push({ source: gn.parentId, target: gn.id, isCrosslink: false });
      }
    }
    for (const cl of opts.crosslinks) {
      const hasS = this.graphNodes.some((n) => n.id === cl.sourceId);
      const hasT = this.graphNodes.some((n) => n.id === cl.targetId);
      if (hasS && hasT) {
        this.edges.push({ source: cl.sourceId, target: cl.targetId, isCrosslink: true });
      }
    }

    // FrameBuffer for graph — exact size, no overlap
    this.fb = new FrameBufferRenderable(this.renderer, {
      id: "graph-fb",
      width: this.gw,
      height: this.gh,
    });

    // Peek panel — positioned beside the graph by the caller via flexbox
    this.peekBox = new BoxRenderable(this.renderer, {
      id: "graph-peek",
      width: 32,
      height: "100%",
      border: true,
      borderStyle: "rounded",
      borderColor: "#bb9af7",
      paddingLeft: 1,
      paddingRight: 1,
      paddingTop: 1,
      flexDirection: "column",
      overflow: "hidden",
    });

    this.peekScroll = new ScrollBoxRenderable(this.renderer, {
      id: "graph-peek-scroll",
      scrollY: true,
      scrollX: false,
    });
    this.peekBox.add(this.peekScroll);

    this.peekText = new TextRenderable(this.renderer, {
      id: "graph-peek-text",
      content: "",
      width: "100%",
    });
    this.peekScroll.content.add(this.peekText);

    if (this.graphNodes.length > 0) this.updatePeek();
  }

  getRenderables(): { fb: FrameBufferRenderable; peek: BoxRenderable } {
    return { fb: this.fb, peek: this.peekBox };
  }

  start() {
    // Pre-settle
    for (let i = 0; i < 100; i++) {
      simulate(this.graphNodes, this.gw, this.gh);
    }
    renderGraph(this.fb, this.graphNodes, this.edges, this.getSelectedId(), this.gw, this.gh);

    (this.renderer as any).requestLive?.();
    this.interval = setInterval(() => {
      simulate(this.graphNodes, this.gw, this.gh);
      renderGraph(this.fb, this.graphNodes, this.edges, this.getSelectedId(), this.gw, this.gh);
    }, 100); // 10fps — gentle
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    (this.renderer as any).dropLive?.();
  }

  handleKey(key: KeyEvent) {
    if (this.graphNodes.length === 0) return;
    const current = this.graphNodes[this.selectedIdx];
    if (!current) return;

    let target: GNode | null = null;

    switch (key.name) {
      case "right": case "l":
        target = this.findNearest(current, 1, 0);
        break;
      case "left": case "h":
        target = this.findNearest(current, -1, 0);
        break;
      case "down": case "j":
        target = this.findNearest(current, 0, 1);
        break;
      case "up": case "k":
        target = this.findNearest(current, 0, -1);
        break;
      case "return":
        this.onNodeSelect?.(this.getSelectedId());
        return;
    }

    if (target) {
      this.selectedIdx = this.graphNodes.indexOf(target);
      this.updatePeek();
    }
  }

  /**
   * Find the nearest node in a direction from the current node.
   * dx/dy indicate direction: (1,0) = right, (-1,0) = left, (0,1) = down, (0,-1) = up.
   * Scores candidates by: must be in the correct half-plane, then by distance
   * weighted to prefer nodes more aligned with the direction.
   */
  private findNearest(from: GNode, dx: number, dy: number): GNode | null {
    let best: GNode | null = null;
    let bestScore = Infinity;

    for (const candidate of this.graphNodes) {
      if (candidate.id === from.id) continue;

      const cdx = candidate.x - from.x;
      const cdy = (candidate.y - from.y) * 2; // Scale Y for terminal aspect

      // Check the candidate is in the right direction
      const dot = cdx * dx + cdy * dy;
      if (dot <= 0) continue; // Wrong direction entirely

      // Distance
      const dist = Math.sqrt(cdx * cdx + cdy * cdy);

      // Alignment: how well does the candidate's direction match?
      // 1.0 = perfectly aligned, 0.0 = perpendicular
      const alignment = dot / (dist * Math.sqrt(dx * dx + dy * dy) + 0.001);

      // Score: prefer close + aligned. Penalize misalignment heavily.
      const score = dist / (alignment * alignment + 0.01);

      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    return best;
  }

  getSelectedId(): string {
    return this.graphNodes[this.selectedIdx]?.id || "";
  }

  private updatePeek() {
    const gn = this.graphNodes[this.selectedIdx];
    if (!gn) return;

    const lainNode = this.allLainNodes.find((n) => n.id === gn.id);
    const content = lainNode?.content
      ? (lainNode.content.length > 300 ? lainNode.content.slice(0, 297) + "…" : lainNode.content)
      : "(no content)";

    this.peekText.content = t`${bold(fg("#c0caf5")(gn.title))}

${fg("#7aa2f7")("id")}  ${gn.id}
${fg("#7aa2f7")("depth")}  ${String(gn.depth)}
${fg("#7aa2f7")("status")}  ${gn.status}

${content}
`;
    this.peekScroll.scrollTop = 0;
  }
}
