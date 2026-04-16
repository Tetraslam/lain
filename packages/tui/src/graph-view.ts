/**
 * Radial tree graph view with infinite canvas, viewport panning,
 * minimap, depth-scaled node labels, and tight packing.
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
  label: string; // Depth-scaled label (longer for shallow, shorter for deep)
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
const ROOT_BG = RGBA.fromHex("#292e42");
const ROOT_FG = RGBA.fromHex("#7aa2f7");
const DEPTH1_FG = RGBA.fromHex("#c0caf5");
const EDGE_COLOR = RGBA.fromHex("#565f89");
const CROSSLINK_COLOR = RGBA.fromHex("#bb9af7");
const PRUNED_FG = RGBA.fromHex("#f7768e");
const MINIMAP_BG = RGBA.fromHex("#16161e");
const MINIMAP_NODE = RGBA.fromHex("#565f89");
const MINIMAP_SELECTED = RGBA.fromHex("#bb9af7");
const MINIMAP_VIEWPORT = RGBA.fromHex("#3b3f5c");

// ============================================================================
// Label sizing by depth
// ============================================================================

function makeLabel(title: string, depth: number): string {
  const maxLen = depth === 0 ? 40 : depth === 1 ? 28 : depth === 2 ? 18 : 12;
  const t = title || "?";
  return t.length > maxLen ? t.slice(0, maxLen - 1) + "…" : t;
}

// ============================================================================
// Radial Tree Layout — tight packing
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
  for (const [, ch] of childrenOf) ch.sort((a, b) => a.branchIndex - b.branchIndex);

  // Tighter ring spacing — pack nodes closer
  const maxDepth = Math.max(...active.map((n) => n.depth), 0);
  const ringSpacing = Math.max(12, Math.min(20, 60 / (maxDepth + 1)));

  const result: GNode[] = [];

  function layout(node: LainNode, angleStart: number, angleEnd: number, depth: number) {
    const angle = (angleStart + angleEnd) / 2;
    const radius = depth * ringSpacing;
    const ax = Math.cos(angle) * radius;
    const ay = Math.sin(angle) * radius * 0.45;
    const label = makeLabel(node.title || node.id, depth);

    result.push({
      id: node.id, title: node.title || node.id, label,
      depth: node.depth, status: node.status,
      x: ax, y: ay, anchorX: ax, anchorY: ay,
      vx: 0, vy: 0, parentId: node.parentId,
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
      if (Math.abs(a.depth - b.depth) > 1) continue;
      const dx = a.x - b.x, dy = (a.y - b.y) * 2;
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 2);
      if (dist < 14) {
        const force = 25 / (dist * dist);
        a.vx += (dx / dist) * force; a.vy += ((dy / 2) / dist) * force;
        b.vx -= (dx / dist) * force; b.vy -= ((dy / 2) / dist) * force;
      }
    }
  }
  for (const n of nodes) {
    n.vx += (n.anchorX - n.x) * 0.08;
    n.vy += (n.anchorY - n.y) * 0.08;
    n.vx *= 0.65; n.vy *= 0.65;
    const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
    if (speed > 0.3) { n.vx = (n.vx / speed) * 0.3; n.vy = (n.vy / speed) * 0.3; }
    n.x += n.vx; n.y += n.vy;
  }
}

// ============================================================================
// Rendering
// ============================================================================

function renderGraph(
  fb: FrameBufferRenderable, nodes: GNode[], edges: GEdge[],
  selectedId: string, vw: number, vh: number, camX: number, camY: number
): void {
  const buf = fb.frameBuffer;
  const map = new Map(nodes.map((n) => [n.id, n]));
  const ox = Math.round(vw / 2 - camX);
  const oy = Math.round(vh / 2 - camY);

  buf.fillRect(0, 0, vw, vh, BG);

  // Edges
  for (const edge of edges) {
    const a = map.get(edge.source), b = map.get(edge.target);
    if (!a || !b) continue;
    const ax = Math.round(a.x + ox), ay = Math.round(a.y + oy);
    const bx = Math.round(b.x + ox), by = Math.round(b.y + oy);
    if ((ax < -40 && bx < -40) || (ax > vw + 40 && bx > vw + 40)) continue;
    if ((ay < -15 && by < -15) || (ay > vh + 15 && by > vh + 15)) continue;
    const color = edge.isCrosslink ? CROSSLINK_COLOR : EDGE_COLOR;
    drawLine(buf, ax, ay, bx, by, "·", color, BG, edge.isCrosslink ? 1 : 2, vw, vh);
  }

  // Nodes — selected last
  const sorted = [...nodes].sort((a, b) => (a.id === selectedId ? 1 : 0) - (b.id === selectedId ? 1 : 0));
  for (const node of sorted) {
    const sx = Math.round(node.x + ox);
    const sy = Math.round(node.y + oy);
    if (sy < -1 || sy >= vh + 1) continue;
    const label = ` ${node.label} `;
    if (sx + label.length < 0 || sx >= vw) continue;

    const isSelected = node.id === selectedId;
    const isRoot = node.depth === 0;
    const isD1 = node.depth === 1;

    let nodeFg = NODE_FG, nodeBg = BG;
    if (isSelected) { nodeFg = SELECTED_FG; nodeBg = SELECTED_BG; }
    else if (isRoot) { nodeFg = ROOT_FG; nodeBg = ROOT_BG; }
    else if (isD1) { nodeFg = DEPTH1_FG; }
    else if (node.status === "pruned") { nodeFg = PRUNED_FG; }

    buf.drawText(label, sx, sy, nodeFg, nodeBg);
  }

  // Minimap (bottom-right corner)
  renderMinimap(buf, nodes, selectedId, vw, vh, camX, camY);
}

function renderMinimap(
  buf: any, nodes: GNode[], selectedId: string,
  vw: number, vh: number, camX: number, camY: number
): void {
  if (nodes.length === 0) return;

  const mmW = 20, mmH = 10;
  const mmX = vw - mmW - 1, mmY = vh - mmH - 1;

  // Compute world bounds
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
  }
  const worldW = Math.max(maxX - minX, 10);
  const worldH = Math.max(maxY - minY, 5);

  // Draw minimap bg
  buf.fillRect(mmX, mmY, mmW, mmH, MINIMAP_BG);

  // Draw viewport rectangle
  const vpLeft = ((camX - vw / 2) - minX) / worldW * mmW;
  const vpTop = ((camY - vh / 2) - minY) / worldH * mmH;
  const vpW = (vw / worldW) * mmW;
  const vpH = (vh / worldH) * mmH;
  for (let x = Math.max(0, Math.floor(vpLeft)); x < Math.min(mmW, Math.ceil(vpLeft + vpW)); x++) {
    for (let y = Math.max(0, Math.floor(vpTop)); y < Math.min(mmH, Math.ceil(vpTop + vpH)); y++) {
      buf.setCell(mmX + x, mmY + y, " ", MINIMAP_VIEWPORT, MINIMAP_VIEWPORT);
    }
  }

  // Draw nodes as dots
  for (const n of nodes) {
    const nx = Math.round(((n.x - minX) / worldW) * (mmW - 1));
    const ny = Math.round(((n.y - minY) / worldH) * (mmH - 1));
    if (nx >= 0 && nx < mmW && ny >= 0 && ny < mmH) {
      const color = n.id === selectedId ? MINIMAP_SELECTED : MINIMAP_NODE;
      buf.setCell(mmX + nx, mmY + ny, "●", color, MINIMAP_BG);
    }
  }
}

function drawLine(
  buf: any, x0: number, y0: number, x1: number, y1: number,
  ch: string, color: RGBA, bg: RGBA, spacing: number, vw: number, vh: number
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
  private vw: number;
  private vh: number;
  private camX = 0;
  private camY = 0;
  private targetCamX = 0;
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

    this.graphNodes = computeRadialLayout(opts.nodes);

    for (const gn of this.graphNodes) {
      if (gn.parentId) this.edges.push({ source: gn.parentId, target: gn.id, isCrosslink: false });
    }
    for (const cl of opts.crosslinks) {
      const hasS = this.graphNodes.some((n) => n.id === cl.sourceId);
      const hasT = this.graphNodes.some((n) => n.id === cl.targetId);
      if (hasS && hasT) this.edges.push({ source: cl.sourceId, target: cl.targetId, isCrosslink: true });
    }

    this.fb = new FrameBufferRenderable(this.renderer, {
      id: "graph-fb", width: this.vw, height: this.vh,
    });

    this.peekBox = new BoxRenderable(this.renderer, {
      id: "graph-peek", width: 32, height: "100%",
      border: true, borderStyle: "rounded", borderColor: "#bb9af7",
      paddingLeft: 1, paddingRight: 1, paddingTop: 1,
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

    if (this.graphNodes.length > 0) this.updatePeek();
  }

  getRenderables(): { fb: FrameBufferRenderable; peek: BoxRenderable } {
    return { fb: this.fb, peek: this.peekBox };
  }

  start() {
    for (let i = 0; i < 60; i++) simulate(this.graphNodes);
    renderGraph(this.fb, this.graphNodes, this.edges, this.getSelectedId(), this.vw, this.vh, this.camX, this.camY);

    (this.renderer as any).requestLive?.();
    this.interval = setInterval(() => {
      simulate(this.graphNodes);
      this.camX += (this.targetCamX - this.camX) * 0.2;
      this.camY += (this.targetCamY - this.camY) * 0.2;
      renderGraph(this.fb, this.graphNodes, this.edges, this.getSelectedId(), this.vw, this.vh, this.camX, this.camY);
    }, 33); // 30fps
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    (this.renderer as any).dropLive?.();
  }

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
      case "right": case "l": target = this.findNearest(current, 1, 0); break;
      case "left": case "h": target = this.findNearest(current, -1, 0); break;
      case "down": case "j": target = this.findNearest(current, 0, 1); break;
      case "up": case "k": target = this.findNearest(current, 0, -1); break;
      case "return": this.onNodeSelect?.(this.getSelectedId()); return;
    }

    if (target) {
      this.selectedIdx = this.graphNodes.indexOf(target);
      this.panToSelected();
      this.updatePeek();
    }
  }

  private panToSelected() {
    const node = this.graphNodes[this.selectedIdx];
    if (node) { this.targetCamX = node.x; this.targetCamY = node.y; }
  }

  private findNearest(from: GNode, dx: number, dy: number): GNode | null {
    let best: GNode | null = null, bestScore = Infinity;
    for (const c of this.graphNodes) {
      if (c.id === from.id) continue;
      const cdx = c.x - from.x, cdy = (c.y - from.y) * 2;
      const dot = cdx * dx + cdy * dy;
      if (dot <= 0) continue;
      const dist = Math.sqrt(cdx * cdx + cdy * cdy);
      const alignment = dot / (dist * Math.sqrt(dx * dx + dy * dy) + 0.001);
      const score = dist / (alignment * alignment + 0.01);
      if (score < bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  getSelectedId(): string {
    return this.graphNodes[this.selectedIdx]?.id || "";
  }

  private updatePeek() {
    const gn = this.graphNodes[this.selectedIdx];
    if (!gn) return;
    const ln = this.allLainNodes.find((n) => n.id === gn.id);
    const content = ln?.content
      ? (ln.content.length > 300 ? ln.content.slice(0, 297) + "…" : ln.content)
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
