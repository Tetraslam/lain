/**
 * Radial tree graph view with infinite canvas and viewport panning.
 *
 * Nodes live in world-space coordinates. A camera/viewport determines
 * what's visible. Camera follows the selected node with smooth panning.
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
  // World-space position
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
// Radial Tree Layout — positions in world space, no clamping
// ============================================================================

function computeRadialLayout(lainNodes: LainNode[]): GNode[] {
  const active = lainNodes.filter((n) => n.status !== "pruned");
  if (active.length === 0) return [];

  const root = active.find((n) => n.parentId === null);
  if (!root) return [];

  const childrenOf = new Map<string, LainNode[]>();
  for (const n of active) {
    if (n.parentId) {
      const siblings = childrenOf.get(n.parentId) || [];
      siblings.push(n);
      childrenOf.set(n.parentId, siblings);
    }
  }
  for (const [, children] of childrenOf) {
    children.sort((a, b) => a.branchIndex - b.branchIndex);
  }

  const maxDepth = Math.max(...active.map((n) => n.depth), 0);
  // Generous spacing: 25 chars per ring so trees spread wide
  const ringSpacing = Math.max(25, 20 + active.length * 0.5);

  const result: GNode[] = [];

  function layout(node: LainNode, angleStart: number, angleEnd: number, depth: number) {
    const angle = (angleStart + angleEnd) / 2;
    const radius = depth * ringSpacing;

    const ax = Math.cos(angle) * radius;
    const ay = Math.sin(angle) * radius * 0.45; // Terminal aspect correction

    const shortTitle = node.title
      ? (node.title.length > 28 ? node.title.slice(0, 27) + "…" : node.title)
      : node.id;

    result.push({
      id: node.id,
      title: node.title || node.id,
      shortTitle,
      depth: node.depth,
      status: node.status,
      x: ax, y: ay,
      anchorX: ax, anchorY: ay,
      vx: 0, vy: 0,
      parentId: node.parentId,
    });

    const children = childrenOf.get(node.id) || [];
    if (children.length === 0) return;

    const arcSpan = angleEnd - angleStart;
    const childArc = arcSpan / children.length;

    children.forEach((child, i) => {
      layout(child, angleStart + childArc * i, angleStart + childArc * (i + 1), depth + 1);
    });
  }

  layout(root, 0, Math.PI * 2, 0);
  return result;
}

// ============================================================================
// Gentle Physics
// ============================================================================

function simulate(nodes: GNode[]): void {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (a.depth !== b.depth) continue;
      const dx = a.x - b.x;
      const dy = (a.y - b.y) * 2;
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 3);
      if (dist < 20) {
        const force = 40 / (dist * dist);
        a.vx += (dx / dist) * force;
        a.vy += ((dy / 2) / dist) * force;
        b.vx -= (dx / dist) * force;
        b.vy -= ((dy / 2) / dist) * force;
      }
    }
  }

  for (const n of nodes) {
    n.vx += (n.anchorX - n.x) * 0.06;
    n.vy += (n.anchorY - n.y) * 0.06;
    n.vx *= 0.7;
    n.vy *= 0.7;
    const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
    if (speed > 0.4) { n.vx = (n.vx / speed) * 0.4; n.vy = (n.vy / speed) * 0.4; }
    n.x += n.vx;
    n.y += n.vy;
  }
}

// ============================================================================
// Viewport Rendering
// ============================================================================

function renderGraph(
  fb: FrameBufferRenderable,
  nodes: GNode[],
  edges: GEdge[],
  selectedId: string,
  vw: number, vh: number,  // viewport size (terminal cells)
  camX: number, camY: number  // camera center in world space
): void {
  const buf = fb.frameBuffer;
  const map = new Map(nodes.map((n) => [n.id, n]));

  // World-to-screen transform: offset so camX,camY maps to viewport center
  const offsetX = Math.round(vw / 2 - camX);
  const offsetY = Math.round(vh / 2 - camY);

  buf.fillRect(0, 0, vw, vh, BG);

  // Draw edges (only if at least one endpoint is visible)
  for (const edge of edges) {
    const a = map.get(edge.source), b = map.get(edge.target);
    if (!a || !b) continue;

    const ax = Math.round(a.x + offsetX), ay = Math.round(a.y + offsetY);
    const bx = Math.round(b.x + offsetX), by = Math.round(b.y + offsetY);

    // Skip if both endpoints are way off screen
    if (ax < -50 && bx < -50) continue;
    if (ax > vw + 50 && bx > vw + 50) continue;
    if (ay < -20 && by < -20) continue;
    if (ay > vh + 20 && by > vh + 20) continue;

    const color = edge.isCrosslink ? CROSSLINK_COLOR : EDGE_COLOR;
    const ch = edge.isCrosslink ? ":" : "·";
    const spacing = edge.isCrosslink ? 1 : 2;
    drawDottedLine(buf, ax, ay, bx, by, ch, color, BG, spacing, vw, vh);
  }

  // Draw nodes — selected last
  const sorted = [...nodes].sort((a, b) => (a.id === selectedId ? 1 : 0) - (b.id === selectedId ? 1 : 0));
  for (const node of sorted) {
    const sx = Math.round(node.x + offsetX);
    const sy = Math.round(node.y + offsetY);
    const label = ` ${node.shortTitle} `;

    // Skip if off screen (with margin for label width)
    if (sy < 0 || sy >= vh) continue;
    if (sx + label.length < 0 || sx >= vw) continue;

    const isSelected = node.id === selectedId;
    if (isSelected) {
      buf.drawText(label, sx, sy, SELECTED_FG, SELECTED_BG);
    } else if (node.depth === 0) {
      buf.drawText(label, sx, sy, ROOT_FG, BG);
    } else if (node.status === "pruned") {
      buf.drawText(label, sx, sy, PRUNED_FG, BG);
    } else {
      buf.drawText(label, sx, sy, NODE_FG, BG);
    }
  }
}

function drawDottedLine(
  buf: any, x0: number, y0: number, x1: number, y1: number,
  ch: string, color: RGBA, bg: RGBA, spacing: number,
  vw: number, vh: number
): void {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, steps = 0;
  while (true) {
    if (steps % spacing === 0 && x0 >= 0 && x0 < vw && y0 >= 0 && y0 < vh) {
      buf.setCell(x0, y0, ch, color, bg);
    }
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
    steps++;
    if (steps > 2000) break;
  }
}

// ============================================================================
// Graph View
// ============================================================================

export interface GraphViewOptions {
  renderer: RenderContext;
  nodes: LainNode[];
  crosslinks: Crosslink[];
  graphWidth: number;
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
  private vw: number;  // viewport width
  private vh: number;  // viewport height
  private camX = 0;    // camera center in world space
  private camY = 0;
  private targetCamX = 0;  // smooth camera target
  private targetCamY = 0;
  private onNodeSelect?: (nodeId: string) => void;
  private allLainNodes: LainNode[];

  peekBox: BoxRenderable;
  private peekScroll: ScrollBoxRenderable;
  private peekText: TextRenderable;

  constructor(opts: GraphViewOptions) {
    this.renderer = opts.renderer;
    this.vw = opts.graphWidth;
    this.vh = opts.graphHeight;
    this.onNodeSelect = opts.onNodeSelect;
    this.allLainNodes = opts.nodes;

    // Compute radial layout in world space (no clamping)
    this.graphNodes = computeRadialLayout(opts.nodes);

    // Build edges
    for (const gn of this.graphNodes) {
      if (gn.parentId) this.edges.push({ source: gn.parentId, target: gn.id, isCrosslink: false });
    }
    for (const cl of opts.crosslinks) {
      const hasS = this.graphNodes.some((n) => n.id === cl.sourceId);
      const hasT = this.graphNodes.some((n) => n.id === cl.targetId);
      if (hasS && hasT) this.edges.push({ source: cl.sourceId, target: cl.targetId, isCrosslink: true });
    }

    // Camera starts at root (world origin)
    this.camX = 0;
    this.camY = 0;
    this.targetCamX = 0;
    this.targetCamY = 0;

    this.fb = new FrameBufferRenderable(this.renderer, {
      id: "graph-fb",
      width: this.vw,
      height: this.vh,
    });

    // Peek panel
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
    // Pre-settle physics
    for (let i = 0; i < 80; i++) simulate(this.graphNodes);

    // Initial render
    renderGraph(this.fb, this.graphNodes, this.edges, this.getSelectedId(), this.vw, this.vh, this.camX, this.camY);

    (this.renderer as any).requestLive?.();
    this.interval = setInterval(() => {
      simulate(this.graphNodes);

      // Smooth camera pan toward target
      this.camX += (this.targetCamX - this.camX) * 0.15;
      this.camY += (this.targetCamY - this.camY) * 0.15;

      renderGraph(this.fb, this.graphNodes, this.edges, this.getSelectedId(), this.vw, this.vh, this.camX, this.camY);
    }, 80); // 12fps
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    (this.renderer as any).dropLive?.();
  }

  /** Resize the graph viewport. Call when terminal resizes. */
  resize(newWidth: number, newHeight: number) {
    this.vw = newWidth;
    this.vh = newHeight;
    this.fb.width = newWidth;
    this.fb.height = newHeight;
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
      this.panToSelected();
      this.updatePeek();
    }
  }

  private panToSelected() {
    const node = this.graphNodes[this.selectedIdx];
    if (node) {
      this.targetCamX = node.x;
      this.targetCamY = node.y;
    }
  }

  private findNearest(from: GNode, dx: number, dy: number): GNode | null {
    let best: GNode | null = null;
    let bestScore = Infinity;

    for (const candidate of this.graphNodes) {
      if (candidate.id === from.id) continue;

      const cdx = candidate.x - from.x;
      const cdy = (candidate.y - from.y) * 2;

      const dot = cdx * dx + cdy * dy;
      if (dot <= 0) continue;

      const dist = Math.sqrt(cdx * cdx + cdy * cdy);
      const alignment = dot / (dist * Math.sqrt(dx * dx + dy * dy) + 0.001);
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
